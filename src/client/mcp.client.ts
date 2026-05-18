import type {
    IEventSource,
    IMcpClient,
    IMessageTransport,
    McpClientInfo,
    McpInitializeResult,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpServerInfo,
    McpTool,
    McpToolResult,
} from "../interfaces";
import { createEventEmitter, IEventEmitter } from "../interfaces";
import { MultiplexTransport } from "../server/multiplex.transport";

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

/**
 * Minimalist MCP client that communicates with an MCP server over any
 * {@link IMessageTransport}.
 *
 * Handles the JSON-RPC 2.0 protocol, the MCP initialization handshake,
 * and provides typed wrappers for `resources/*` and `tools/*` operations.
 *
 * @example
 * ```typescript
 * const client = new McpClient({ name: "swarm-peer", version: "1.0.0" }, transport);
 * const initResult = await client.connect();
 * console.log(initResult.serverInfo.name);
 *
 * const tools = await client.listTools();
 * const result = await client.callTool("camera_set_target", { uri: "app://camera/cam1", target: { x: 0, y: 5, z: 0 } });
 * ```
 */
export class McpClient implements IMcpClient {
    private readonly _clientInfo: McpClientInfo;
    private readonly _transport: IMessageTransport;
    private readonly _timeoutMs: number;

    private _nextId = 1;
    private _pending = new Map<number, PendingRequest>();
    private _connected = false;
    private _serverInfo: McpServerInfo | undefined;

    private _onResourcesChanged?: IEventEmitter<void>;
    private _onToolsChanged?: IEventEmitter<void>;

    /**
     * @param clientInfo Identity sent to the server during the `initialize` handshake.
     * @param transport  The transport to communicate over.
     * @param timeoutMs  Timeout in milliseconds for individual requests (default 30 000).
     */
    constructor(clientInfo: McpClientInfo, transport: IMessageTransport, timeoutMs = 30_000) {
        this._clientInfo = clientInfo;
        this._transport = transport;
        this._timeoutMs = timeoutMs;
    }

    // ── IMcpClient properties ────────────────────────────────────────────

    public get name(): string {
        return this._clientInfo.name;
    }

    public get isConnected(): boolean {
        return this._connected;
    }

    public get serverInfo(): McpServerInfo | undefined {
        return this._serverInfo;
    }

    public get onResourcesChanged(): IEventSource<void> | null {
        if (!this._onResourcesChanged) {
            this._onResourcesChanged = createEventEmitter<void>();
        }
        return this._onResourcesChanged;
    }

    public get onToolsChanged(): IEventSource<void> | null {
        if (!this._onToolsChanged) {
            this._onToolsChanged = createEventEmitter<void>();
        }
        return this._onToolsChanged;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    public connect(): Promise<McpInitializeResult> {
        return new Promise<McpInitializeResult>((resolve, reject) => {
            // Wire transport callbacks
            this._transport.onMessage = (data: string) => this._onMessage(data);

            this._transport.onError = () => {
                if (!this._connected) {
                    reject(new Error("McpClient: transport error during connect"));
                }
            };

            this._transport.onClose = () => {
                this._connected = false;
                this._rejectAllPending("McpClient: transport closed");
            };

            this._transport.onOpen = () => {
                // Perform the MCP handshake
                this._request("initialize", {
                    protocolVersion: "2024-11-05",
                    clientInfo: this._clientInfo,
                    capabilities: {},
                })
                    .then((result) => {
                        const initResult = result as McpInitializeResult;
                        this._serverInfo = initResult.serverInfo;
                        this._connected = true;

                        // Send notifications/initialized (no response expected)
                        this._notify("notifications/initialized");

                        resolve(initResult);
                    })
                    .catch(reject);
            };

            // Open the transport
            if (this._transport instanceof MultiplexTransport) {
                this._transport.activate();
            } else if ("connect" in this._transport && typeof (this._transport as { connect: unknown }).connect === "function") {
                (this._transport as { connect(): void }).connect();
            }
        });
    }

    public disconnect(): void {
        this._connected = false;
        this._serverInfo = undefined;
        this._rejectAllPending("McpClient: disconnected");
        this._transport.close();
        this._onResourcesChanged?.clear();
        this._onResourcesChanged = undefined;
        this._onToolsChanged?.clear();
        this._onToolsChanged = undefined;
    }

    // ── Resources ────────────────────────────────────────────────────────

    public async listResources(): Promise<McpResource[]> {
        const r = await this._request("resources/list");
        return (r as { resources: McpResource[] }).resources;
    }

    public async listResourceTemplates(): Promise<McpResourceTemplate[]> {
        const r = await this._request("resources/templates/list");
        return (r as { resourceTemplates: McpResourceTemplate[] }).resourceTemplates;
    }

    public async readResource(uri: string): Promise<McpResourceContent> {
        const r = await this._request("resources/read", { uri });
        return (r as { contents: McpResourceContent[] }).contents[0];
    }

    // ── Tools ────────────────────────────────────────────────────────────

    public async listTools(): Promise<McpTool[]> {
        const r = await this._request("tools/list");
        return (r as { tools: McpTool[] }).tools;
    }

    public async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const r = await this._request("tools/call", { name, arguments: args });
        return r as McpToolResult;
    }

    // ── JSON-RPC internals ───────────────────────────────────────────────

    private _request(method: string, params?: unknown): Promise<unknown> {
        const id = this._nextId++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`McpClient: request "${method}" (id=${id}) timed out after ${this._timeoutMs}ms`));
            }, this._timeoutMs);

            this._pending.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
            this._transport.send(msg);
        });
    }

    private _notify(method: string, params?: unknown): void {
        const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
        this._transport.send(msg);
    }

    private _onMessage(data: string): void {
        let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string };
        try {
            msg = JSON.parse(data);
        } catch {
            return; // malformed — drop silently
        }

        // Response to a pending request
        if (msg.id !== undefined) {
            const pending = this._pending.get(msg.id);
            if (!pending) return;
            this._pending.delete(msg.id);
            clearTimeout(pending.timer);

            if (msg.error) {
                pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
                pending.resolve(msg.result);
            }
            return;
        }

        // Notification from server (no id)
        if (msg.method) {
            switch (msg.method) {
                case "notifications/resources/list_changed":
                    this._onResourcesChanged?.emit();
                    break;
                case "notifications/tools/list_changed":
                    this._onToolsChanged?.emit();
                    break;
            }
        }
    }

    private _rejectAllPending(reason: string): void {
        for (const [id, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
            this._pending.delete(id);
        }
    }
}
