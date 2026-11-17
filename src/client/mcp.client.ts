import type {
    IEventSource,
    IMcpClient,
    IMessageTransport,
    IMcpClientOptions,
    McpClientCapabilities,
    McpClientInfo,
    McpNotificationMessage,
    McpCompletion,
    McpCompletionArgument,
    McpCompletionReference,
    McpInitializeResult,
    McpLoggingLevel,
    McpPrompt,
    McpPromptResult,
    McpRequestOptions,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpServerCapabilities,
    McpServerInfo,
    McpTool,
    McpToolResult,
} from "../interfaces";
import { createEventEmitter, IEventEmitter } from "../interfaces";
import { isProtocolVersionSupported, MCP_ERROR_CODES, MCP_LATEST_PROTOCOL_VERSION, MCP_META, MCP_STATELESS_PROTOCOL_VERSIONS } from "../mcp.protocol";

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Detaches the abort listener of a call made with a signal. */
    release?: () => void;
}

/**
 * A JSON-RPC error answered by the server. `message` keeps the
 * `MCP error <code>: <message>` form; `code` and `data` are the raw fields.
 */
export class McpRpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(`MCP error ${code}: ${message}`);
        this.name = "McpRpcError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a stateless `subscriptions/listen` asks for. */
interface IListenFilter {
    toolsListChanged?: boolean;
    promptsListChanged?: boolean;
    resourcesListChanged?: boolean;
    resourceSubscriptions?: string[];
}

/** Extra knobs of one request, internal. */
interface IRequestTuning {
    /** Write the stateless `_meta` even before the era is settled (the discover probe). */
    readonly stateless?: boolean;
    /** The revision to write in `_meta`, during the probe. */
    readonly version?: string;
    /** Overrides the client's timeout for this request. */
    readonly timeoutMs?: number;
}

/** The error a cancelled call rejects with, shaped like the platform's. */
function abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) return reason;
    const error = new Error(typeof reason === "string" && reason ? reason : "The operation was aborted");
    error.name = "AbortError";
    return error;
}

/** A human-readable reason for `notifications/cancelled`, from an abort reason. */
function reasonOf(signal: AbortSignal): string | undefined {
    const reason: unknown = signal.reason;
    if (typeof reason === "string") return reason || undefined;
    if (reason instanceof Error && reason.message && reason.message !== "This operation was aborted") return reason.message;
    return undefined;
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
    private readonly _capabilities: McpClientCapabilities;
    private readonly _protocol: "legacy" | "auto" | "stateless";
    private readonly _probeTimeoutMs: number;

    /** `true` once connected to a server in the stateless era (2026-07-28 and later). */
    private _stateless = false;
    /** Stateless: the level written in each request's `_meta`, set by {@link setLoggingLevel}. */
    private _logLevel: McpLoggingLevel | undefined;
    /** Stateless: the id of the open `subscriptions/listen`, if any. */
    private _listenId: number | undefined;
    /** Stateless: resolves the open listen's acknowledgement. */
    private readonly _listenAcks = new Map<number, (filter: IListenFilter) => void>();
    /** Stateless: the URIs {@link subscribeResource} asked for. */
    private readonly _listenUris = new Set<string>();
    /** Long-lived requests opened with {@link openStream}, by id. */
    private readonly _streams = new Map<
        number,
        { readonly onNotification: (method: string, params: Record<string, unknown>) => void; resolve(result: unknown): void; reject(error: Error): void }
    >();

    private _nextId = 1;
    private _pending = new Map<number, PendingRequest>();
    private _connected = false;
    private _serverInfo: McpServerInfo | undefined;
    private _protocolVersion: string | undefined;
    private _serverCapabilities: McpServerCapabilities | undefined;

    private _onResourcesChanged?: IEventEmitter<void>;
    private _onNotification?: IEventEmitter<McpNotificationMessage>;
    private _onToolsChanged?: IEventEmitter<void>;
    private _onPromptsChanged?: IEventEmitter<void>;
    private _onResourceUpdated?: IEventEmitter<string>;

    /**
     * @param clientInfo Identity sent to the server during the `initialize` handshake.
     * @param transport  The transport to communicate over.
     * @param timeoutMs  Timeout in milliseconds for individual requests (default 30 000).
     * @param options    What the client declares at `initialize`, its extensions in particular.
     */
    constructor(clientInfo: McpClientInfo, transport: IMessageTransport, timeoutMs = 30_000, options: IMcpClientOptions = {}) {
        this._clientInfo = clientInfo;
        this._transport = transport;
        this._timeoutMs = timeoutMs;
        this._capabilities = options.capabilities ?? {};
        this._protocol = options.protocol ?? "legacy";
        this._probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
    }

    /**
     * `true` when the session is stateless (protocol 2026-07-28 or later): no
     * `initialize` was sent, every request carries its own `_meta`.
     */
    public get isStateless(): boolean {
        return this._stateless;
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

    /** The capabilities the server declared at `initialize`, `undefined` before it and after {@link disconnect}. */
    public get serverCapabilities(): McpServerCapabilities | undefined {
        return this._serverCapabilities;
    }

    /**
     * The settings the server declared for `extensionId` under
     * `capabilities.extensions`, `undefined` when it did not declare it.
     * Call an extension's methods only when this is defined: the spec of each
     * extension forbids calling them otherwise.
     */
    public serverExtension(extensionId: string): Readonly<Record<string, unknown>> | undefined {
        const settings = this._serverCapabilities?.extensions?.[extensionId];
        return typeof settings === "object" && settings !== null && !Array.isArray(settings) ? settings : undefined;
    }

    /**
     * Every server notification, including the ones this client also
     * translates into a dedicated event. Extension clients listen here.
     */
    public get onNotification(): IEventSource<McpNotificationMessage> {
        if (!this._onNotification) this._onNotification = createEventEmitter<McpNotificationMessage>();
        return this._onNotification;
    }

    /**
     * Opens a long-lived request (a stream): no timeout, and every
     * notification the server tags with its id
     * (`_meta["io.modelcontextprotocol/subscriptionId"]`) goes to
     * `onNotification`. `done` settles with the answer when the server ends
     * the stream, rejects with its error when the server refuses it, and
     * resolves `undefined` on {@link close}, which withdraws the request (on
     * Streamable HTTP, by closing its stream).
     */
    public openStream(
        method: string,
        params: Record<string, unknown>,
        onNotification: (method: string, params: Record<string, unknown>) => void
    ): { readonly id: number; readonly done: Promise<unknown>; close(): void } {
        const id = this._nextId++;
        const done = new Promise<unknown>((resolve, reject) => this._streams.set(id, { onNotification, resolve, reject }));
        const payload = this._stateless ? this._withStatelessMeta(params) : params;
        this._transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: payload }));
        return {
            id,
            done,
            close: () => {
                const stream = this._streams.get(id);
                if (!stream) return;
                this._streams.delete(id);
                this._sendCancelled(id, undefined);
                stream.resolve(undefined);
            },
        };
    }

    /**
     * Sends any request and resolves with its raw result. The typed methods
     * of this class are built on it; extension clients use it for the methods
     * they add. Same timeout and cancellation rules as every other call.
     */
    public request<T = unknown>(method: string, params?: unknown, options?: McpRequestOptions): Promise<T> {
        return this._request(method, params, options) as Promise<T>;
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

    /** Emitted with the URI of each `notifications/resources/updated` the server sends. */
    public get onResourceUpdated(): IEventSource<string> {
        if (!this._onResourceUpdated) this._onResourceUpdated = createEventEmitter<string>();
        return this._onResourceUpdated;
    }

    /** Emitted when the server sends `notifications/prompts/list_changed`. */
    public get onPromptsChanged(): IEventSource<void> {
        if (!this._onPromptsChanged) this._onPromptsChanged = createEventEmitter<void>();
        return this._onPromptsChanged;
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
                this._handshake().then(resolve, reject);
            };

            // Open the transport. `connect()` is not part of IMessageTransport ,
            // some transports are handed over already open: so probe for it
            // rather than testing for a specific class.
            if ("connect" in this._transport && typeof (this._transport as { connect: unknown }).connect === "function") {
                (this._transport as { connect(): void }).connect();
            }
        });
    }

    /**
     * Sends a `ping` and resolves when the server answers, rejecting on the
     * usual request timeout. Use it to tell a live connection from a stale one.
     */
    public async ping(): Promise<void> {
        // 2026-07-28 removed ping; server/discover is the cheap round trip left.
        await this._request(this._stateless ? "server/discover" : "ping");
    }

    public disconnect(): void {
        this._closeListen();
        for (const [id, stream] of [...this._streams]) {
            this._streams.delete(id);
            this._sendCancelled(id, undefined);
            stream.reject(new Error("McpClient: disconnected"));
        }
        this._stateless = false;
        this._logLevel = undefined;
        this._listenUris.clear();
        this._connected = false;
        this._serverInfo = undefined;
        this._protocolVersion = undefined;
        this._serverCapabilities = undefined;
        this._rejectAllPending("McpClient: disconnected");
        this._transport.close();
        this._onResourcesChanged?.clear();
        this._onResourcesChanged = undefined;
        this._onToolsChanged?.clear();
        this._onToolsChanged = undefined;
        this._onPromptsChanged?.clear();
        this._onPromptsChanged = undefined;
        this._onResourceUpdated?.clear();
        this._onResourceUpdated = undefined;
    }

    // ── Resources ────────────────────────────────────────────────────────

    public listResources(): Promise<McpResource[]> {
        return this._listAll<McpResource>("resources/list", "resources");
    }

    public listResourceTemplates(): Promise<McpResourceTemplate[]> {
        return this._listAll<McpResourceTemplate>("resources/templates/list", "resourceTemplates");
    }

    public async readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContent> {
        const r = await this._request("resources/read", { uri }, options);
        return (r as { contents: McpResourceContent[] }).contents[0];
    }

    /**
     * Calls `resources/subscribe`; updates then arrive on {@link onResourceUpdated}.
     * Stateless (2026-07-28): reopens the client's `subscriptions/listen` with
     * the URI added, and rejects when the server does not acknowledge it.
     */
    public async subscribeResource(uri: string): Promise<void> {
        if (!this._stateless) {
            await this._request("resources/subscribe", { uri });
            return;
        }
        this._listenUris.add(uri);
        const honored = await this._openListen();
        if (!honored.resourceSubscriptions?.includes(uri)) {
            this._listenUris.delete(uri);
            throw new McpRpcError(-32602, `The server did not accept a subscription to ${uri}`, { uri });
        }
    }

    /** Calls `resources/unsubscribe`; stateless, reopens the listen without the URI. */
    public async unsubscribeResource(uri: string): Promise<void> {
        if (!this._stateless) {
            await this._request("resources/unsubscribe", { uri });
            return;
        }
        if (this._listenUris.delete(uri)) await this._openListen();
    }

    // ── Prompts ──────────────────────────────────────────────────────────

    public listPrompts(): Promise<McpPrompt[]> {
        return this._listAll<McpPrompt>("prompts/list", "prompts");
    }

    public async getPrompt(name: string, args: Record<string, string> = {}, options?: McpRequestOptions): Promise<McpPromptResult> {
        return (await this._request("prompts/get", { name, arguments: args }, options)) as McpPromptResult;
    }

    // ── Completion and logging ───────────────────────────────────────────

    public async complete(ref: McpCompletionReference, argument: McpCompletionArgument, context?: { arguments?: Record<string, string> }): Promise<McpCompletion> {
        const r = await this._request("completion/complete", context ? { ref, argument, context } : { ref, argument });
        return (r as { completion: McpCompletion }).completion;
    }

    /**
     * Calls `logging/setLevel`. Stateless (2026-07-28): no request; the level
     * travels in the `_meta` of every request that follows, which is how the
     * server knows to send `notifications/message` for it.
     */
    public async setLoggingLevel(level: McpLoggingLevel): Promise<void> {
        if (this._stateless) {
            this._logLevel = level;
            return;
        }
        await this._request("logging/setLevel", { level });
    }

    // ── Tools ────────────────────────────────────────────────────────────

    public listTools(): Promise<McpTool[]> {
        return this._listAll<McpTool>("tools/list", "tools");
    }

    public async callTool(name: string, args: Record<string, unknown>, options?: McpRequestOptions): Promise<McpToolResult> {
        const r = await this._request("tools/call", { name, arguments: args }, options);
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

    // ── Handshake: initialize, or server/discover (2026-07-28) ───────────

    /** Opens the conversation in the era {@link IMcpClientOptions.protocol} asks for. */
    private async _handshake(): Promise<McpInitializeResult> {
        if (this._protocol === "legacy") return this._initialize();

        // The spec's probe: a modern server answers server/discover, or a
        // recognized modern error; anything else (an error of any code, or
        // silence) means an older server, which only `initialize` opens.
        const auto = this._protocol === "auto";
        let version = MCP_STATELESS_PROTOCOL_VERSIONS[0];
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await this._request("server/discover", {}, undefined, { stateless: true, version, timeoutMs: auto ? this._probeTimeoutMs : undefined });
                return this._adoptStateless(result, version);
            } catch (error) {
                const supported =
                    error instanceof McpRpcError && error.code === MCP_ERROR_CODES.unsupportedProtocolVersion && isRecord(error.data) ? error.data["supported"] : undefined;
                const common = Array.isArray(supported) ? MCP_STATELESS_PROTOCOL_VERSIONS.find((v) => supported.includes(v)) : undefined;
                if (common !== undefined && common !== version) {
                    version = common;
                    continue;
                }
                if (auto && !(error instanceof McpRpcError && error.code === MCP_ERROR_CODES.unsupportedProtocolVersion)) return this._initialize();
                this._transport.close();
                throw error;
            }
        }
        throw new Error("McpClient: no stateless protocol revision in common with the server");
    }

    /** The handshake of the revisions up to 2025-11-25. */
    private async _initialize(): Promise<McpInitializeResult> {
        // Announce the newest handshake revision we speak.
        const initResult = (await this._request("initialize", {
            protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
            clientInfo: this._clientInfo,
            capabilities: this._capabilities,
        })) as McpInitializeResult;

        // The server answers with the revision it will use, which may
        // differ from ours. The spec says a client that cannot speak it
        // should disconnect rather than trade messages it may misread.
        if (!isProtocolVersionSupported(initResult.protocolVersion)) {
            this._transport.close();
            throw new Error(`McpClient: server requires unsupported MCP protocol version "${initResult.protocolVersion}"`);
        }

        this._protocolVersion = initResult.protocolVersion;
        this._serverInfo = initResult.serverInfo;
        this._serverCapabilities = initResult.capabilities;
        this._connected = true;

        // Hand the negotiated revision to the transport before any
        // further traffic: HTTP transports must stamp it on every
        // subsequent request, starting with the notification below.
        this._transport.setProtocolVersion?.(initResult.protocolVersion);

        // Send notifications/initialized (no response expected)
        this._notify("notifications/initialized");
        return initResult;
    }

    /** Settles a stateless session from a `server/discover` result, then opens the change listen. */
    private async _adoptStateless(result: unknown, requested: string): Promise<McpInitializeResult> {
        const discovered = isRecord(result) ? result : {};
        const offered = Array.isArray(discovered["supportedVersions"]) ? (discovered["supportedVersions"] as unknown[]) : [requested];
        const version = MCP_STATELESS_PROTOCOL_VERSIONS.find((v) => offered.includes(v));
        if (version === undefined) {
            this._transport.close();
            throw new Error(`McpClient: the server speaks ${offered.join(", ")}, none of which this client implements`);
        }
        const meta = isRecord(discovered["_meta"]) ? discovered["_meta"] : {};
        const serverInfo = isRecord(meta[MCP_META.serverInfo]) ? (meta[MCP_META.serverInfo] as McpServerInfo) : { name: "unknown", version: "0.0.0" };

        this._stateless = true;
        this._protocolVersion = version;
        this._serverInfo = serverInfo;
        this._serverCapabilities = isRecord(discovered["capabilities"]) ? (discovered["capabilities"] as McpServerCapabilities) : {};
        this._connected = true;
        this._transport.setProtocolVersion?.(version);
        await this._openListen();

        const instructions = discovered["instructions"];
        return {
            protocolVersion: version,
            capabilities: this._serverCapabilities,
            serverInfo,
            ...(typeof instructions === "string" ? { instructions } : {}),
        } as McpInitializeResult;
    }

    /**
     * (Re)opens the stateless `subscriptions/listen` that carries list changes
     * and the resource updates {@link subscribeResource} asked for. Resolves
     * with the subset the server acknowledged.
     */
    private async _openListen(): Promise<IListenFilter> {
        const capabilities = this._serverCapabilities ?? {};
        const filter: IListenFilter = {};
        if (capabilities.tools?.listChanged) filter.toolsListChanged = true;
        if (capabilities.prompts?.listChanged) filter.promptsListChanged = true;
        if (capabilities.resources?.listChanged) filter.resourcesListChanged = true;
        if (this._listenUris.size > 0 && capabilities.resources?.subscribe) filter.resourceSubscriptions = [...this._listenUris];

        this._closeListen();
        if (Object.keys(filter).length === 0) return {};

        const id = this._nextId++;
        this._listenId = id;
        const acknowledged = new Promise<IListenFilter>((resolve, reject) => {
            const timer = setTimeout(() => {
                this._listenAcks.delete(id);
                reject(new Error(`McpClient: subscriptions/listen (id=${id}) was not acknowledged within ${this._timeoutMs}ms`));
            }, this._timeoutMs);
            this._listenAcks.set(id, (honored) => {
                clearTimeout(timer);
                resolve(honored);
            });
        });
        // Long-lived on purpose: no timeout, it ends when replaced or closed.
        this._transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: this._withStatelessMeta({ notifications: filter }) }));
        return acknowledged;
    }

    /** Withdraws the open listen, if any. */
    private _closeListen(): void {
        const id = this._listenId;
        if (id === undefined) return;
        this._listenId = undefined;
        this._listenAcks.delete(id);
        this._sendCancelled(id, undefined);
    }

    /** `params` with the stateless `_meta` merged in; the caller's own `_meta` keys are kept. */
    private _withStatelessMeta(params: unknown, version?: string): Record<string, unknown> {
        const out: Record<string, unknown> = isRecord(params) ? { ...params } : {};
        out["_meta"] = {
            ...(isRecord(out["_meta"]) ? out["_meta"] : {}),
            [MCP_META.protocolVersion]: version ?? this._protocolVersion ?? MCP_STATELESS_PROTOCOL_VERSIONS[0],
            [MCP_META.clientCapabilities]: this._capabilities,
            [MCP_META.clientInfo]: this._clientInfo,
            ...(this._logLevel !== undefined ? { [MCP_META.logLevel]: this._logLevel } : {}),
        };
        return out;
    }

    // ── JSON-RPC internals ───────────────────────────────────────────────

    /**
     * Sends one request and settles with its answer.
     *
     * A request that times out or whose `signal` aborts is withdrawn with
     * `notifications/cancelled`, so the server can stop working on it, and any
     * answer that still arrives is ignored. `initialize` is never cancelled:
     * the spec forbids it.
     */
    private _request(method: string, params?: unknown, options?: McpRequestOptions, tuning: IRequestTuning = {}): Promise<unknown> {
        const signal = options?.signal;
        const timeoutMs = tuning.timeoutMs ?? this._timeoutMs;
        if (tuning.stateless || this._stateless) params = this._withStatelessMeta(params, tuning.version);
        if (signal?.aborted) return Promise.reject(abortError(signal));

        const id = this._nextId++;

        return new Promise((resolve, reject) => {
            const withdraw = (reason: string | undefined, error: Error): void => {
                const pending = this._pending.get(id);
                if (!pending) return;
                this._pending.delete(id);
                clearTimeout(pending.timer);
                pending.release?.();
                if (method !== "initialize") this._sendCancelled(id, reason);
                reject(error);
            };

            const timer = setTimeout(() => {
                withdraw(`timed out after ${timeoutMs}ms`, new Error(`McpClient: request "${method}" (id=${id}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const pending: PendingRequest = { resolve, reject, timer };
            if (signal) {
                const onAbort = (): void => withdraw(reasonOf(signal), abortError(signal));
                signal.addEventListener("abort", onAbort, { once: true });
                pending.release = () => signal.removeEventListener("abort", onAbort);
            }
            this._pending.set(id, pending);

            const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
            this._transport.send(msg);
        });
    }

    /** Tells the server to stop working on request `id`. Best effort: a closed transport sends nothing. */
    private _sendCancelled(id: number, reason: string | undefined): void {
        if (!this._transport.isOpen) return;
        try {
            this._transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: reason ? { requestId: id, reason } : { requestId: id } }));
        } catch {
            // The request is already withdrawn locally; nothing else to do.
        }
    }

    private _notify(method: string, params?: unknown): void {
        const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
        this._transport.send(msg);
    }

    private _onMessage(data: string): void {
        let msg: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: { uri?: unknown } };
        try {
            msg = JSON.parse(data);
        } catch {
            return; // malformed, drop silently
        }

        // Request from the server: it carries both an id and a method, and it
        // must be answered. Leaving it unanswered hangs the server until its own
        // timeout fires.
        if (msg.id !== undefined && msg.method !== undefined) {
            this._handleServerRequest(msg.id, msg.method);
            return;
        }

        // The server closed our listen (stateless): it answers the listen request.
        if (msg.id !== undefined && msg.id === this._listenId) {
            this._listenId = undefined;
            return;
        }

        // The answer that ends a stream.
        if (msg.id !== undefined && this._streams.has(msg.id)) {
            const stream = this._streams.get(msg.id)!;
            this._streams.delete(msg.id);
            if (msg.error) stream.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data));
            else stream.resolve(msg.result);
            return;
        }

        // Response to a pending request
        if (msg.id !== undefined) {
            const pending = this._pending.get(msg.id);
            if (!pending) return;
            this._pending.delete(msg.id);
            clearTimeout(pending.timer);
            pending.release?.();

            if (msg.error) {
                pending.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data));
            } else {
                pending.resolve(msg.result);
            }
            return;
        }

        // Notification from server (no id)
        if (msg.method) {
            // Stateless: a notification tagged for a listen we replaced or closed is stale.
            const tag =
                isRecord(msg.params) && isRecord((msg.params as Record<string, unknown>)["_meta"])
                    ? ((msg.params as Record<string, unknown>)["_meta"] as Record<string, unknown>)[MCP_META.subscriptionId]
                    : undefined;
            const stream = typeof tag === "number" ? this._streams.get(tag) : undefined;
            if (tag !== undefined && tag !== this._listenId && !stream) return;
            stream?.onNotification(msg.method, isRecord(msg.params) ? (msg.params as Record<string, unknown>) : {});
            if (msg.method === "notifications/subscriptions/acknowledged" && typeof tag === "number") {
                const notifications = (msg.params as Record<string, unknown>)["notifications"];
                this._listenAcks.get(tag)?.(isRecord(notifications) ? (notifications as IListenFilter) : {});
                this._listenAcks.delete(tag);
            }
            this._onNotification?.emit({ method: msg.method, params: msg.params });
            switch (msg.method) {
                case "notifications/resources/list_changed":
                    this._onResourcesChanged?.emit();
                    break;
                case "notifications/tools/list_changed":
                    this._onToolsChanged?.emit();
                    break;
                case "notifications/prompts/list_changed":
                    this._onPromptsChanged?.emit();
                    break;
                case "notifications/resources/updated":
                    if (typeof msg.params?.uri === "string") this._onResourceUpdated?.emit(msg.params.uri);
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
            pending.release?.();
            pending.reject(new Error(reason));
            this._pending.delete(id);
        }
        for (const [id, stream] of [...this._streams]) {
            this._streams.delete(id);
            stream.reject(new Error(reason));
        }
    }
}
