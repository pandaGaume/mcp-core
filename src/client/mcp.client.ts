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
import { isProtocolVersionSupported, MCP_LATEST_PROTOCOL_VERSION } from "../mcp.protocol";
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
    private _protocolVersion: string | undefined;

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

    public get protocolVersion(): string | undefined {
        return this._protocolVersion;
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
                // Perform the MCP handshake, announcing the newest revision we speak.
                this._request("initialize", {
                    protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
                    clientInfo: this._clientInfo,
                    capabilities: {},
                })
                    .then((result) => {
                        const initResult = result as McpInitializeResult;

                        // The server answers with the revision it will use, which may
                        // differ from ours. The spec says a client that cannot speak it
                        // should disconnect rather than trade messages it may misread.
                        if (!isProtocolVersionSupported(initResult.protocolVersion)) {
                            this._transport.close();
                            reject(new Error(`McpClient: server requires unsupported MCP protocol version "${initResult.protocolVersion}"`));
                            return;
                        }

                        this._protocolVersion = initResult.protocolVersion;
                        this._serverInfo = initResult.serverInfo;
                        this._connected = true;

                        // Hand the negotiated revision to the transport before any
                        // further traffic: HTTP transports must stamp it on every
                        // subsequent request, starting with the notification below.
                        this._transport.setProtocolVersion?.(initResult.protocolVersion);

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

    /**
     * Sends a `ping` and resolves when the server answers, rejecting on the
     * usual request timeout. Use it to tell a live connection from a stale one.
     */
    public async ping(): Promise<void> {
        await this._request("ping");
    }

    public disconnect(): void {
        this._connected = false;
        this._serverInfo = undefined;
        this._protocolVersion = undefined;
        this._rejectAllPending("McpClient: disconnected");
        this._transport.close();
        this._onResourcesChanged?.clear();
        this._onResourcesChanged = undefined;
        this._onToolsChanged?.clear();
        this._onToolsChanged = undefined;
    }

    // ── Resources ────────────────────────────────────────────────────────

    public listResources(): Promise<McpResource[]> {
        return this._listAll<McpResource>("resources/list", "resources");
    }

    public listResourceTemplates(): Promise<McpResourceTemplate[]> {
        return this._listAll<McpResourceTemplate>("resources/templates/list", "resourceTemplates");
    }

    public async readResource(uri: string): Promise<McpResourceContent> {
        const r = await this._request("resources/read", { uri });
        return (r as { contents: McpResourceContent[] }).contents[0];
    }

    // ── Tools ────────────────────────────────────────────────────────────

    public listTools(): Promise<McpTool[]> {
        return this._listAll<McpTool>("tools/list", "tools");
    }

    public async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const r = await this._request("tools/call", { name, arguments: args });
        return r as McpToolResult;
    }

    // ── Pagination ───────────────────────────────────────────────────────

    /**
     * Drains a paginated list method into a single array.
     *
     * MCP list operations may return a page plus an opaque `nextCursor`; a
     * client that ignores it silently sees only the first page. Cursors are
     * treated as opaque, and a server echoing the same cursor twice ends the
     * loop rather than spinning forever.
     *
     * @param method - The list method, e.g. `"tools/list"`.
     * @param key    - The result field holding the page, e.g. `"tools"`.
     */
    private async _listAll<T>(method: string, key: string): Promise<T[]> {
        const items: T[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;

        for (;;) {
            const r = (await this._request(method, cursor === undefined ? undefined : { cursor })) as Record<string, unknown>;
            const page = r?.[key];
            if (Array.isArray(page)) items.push(...(page as T[]));

            const next = r?.["nextCursor"];
            if (typeof next !== "string" || next.length === 0 || seen.has(next)) break;
            seen.add(next);
            cursor = next;
        }

        return items;
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

        // Request from the server: it carries both an id and a method, and it
        // must be answered. Leaving it unanswered hangs the server until its own
        // timeout fires.
        if (msg.id !== undefined && msg.method !== undefined) {
            this._handleServerRequest(msg.id, msg.method);
            return;
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

    /**
     * Answers a request issued by the server.
     *
     * `ping` gets the empty result the spec mandates. Anything else (sampling,
     * roots, elicitation) is not implemented yet and gets a clean `-32601`, so
     * the server learns the capability is missing instead of waiting out a
     * timeout.
     */
    private _handleServerRequest(id: number, method: string): void {
        if (method === "ping") {
            this._transport.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
            return;
        }
        this._transport.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
            })
        );
    }

    private _rejectAllPending(reason: string): void {
        for (const [id, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
            this._pending.delete(id);
        }
    }
}
