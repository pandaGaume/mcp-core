import type { IMessageTransport, IMcpBehavior, IMcpInitializer, IMcpRuntimeOperations, IMcpServer, IMcpServerHandlers, IMcpServerOptions, McpGrammarResolver } from "../interfaces";
import type {
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
    McpClientCapabilities,
    McpClientInfo,
    McpInitializeResult,
    McpResource,
    McpResourceTemplate,
    McpServerCapabilities,
    McpTool,
} from "../interfaces";
import type { Unsubscribe } from "../interfaces/eventSource";
import { McpGrammar } from "../mcp.grammar";
import type { McpGrammarStore, McpGrammarStoreChangeEvent } from "../mcp.grammarStore";
import { negotiateProtocolVersion } from "../mcp.protocol";
import { McpToolResults } from "../mcp.toolResult";
import { Mcp } from "./jsonrpc.helpers";

/**
 * Default implementation of {@link IMcpServer}.
 *
 * Routes incoming JSON-RPC messages from its transport to the appropriate MCP
 * handler. Also implements {@link IMcpServerHandlers} so it can act as its own
 * default handler: or delegate to a custom one supplied via the builder's
 * `withHandlers()`.
 *
 * The transport is always supplied by the caller: the server owns the protocol,
 * never the connection. Reconnection, back-off and framing therefore belong to
 * the transport, which is the only party that knows what reconnecting means for
 * the medium it speaks.
 *
 * Lifecycle:
 * ```
 * start() → transport opens → receives messages → dispatches to handlers
 * stop()  → transport closes
 * ```
 */
export class McpServer implements IMcpServer, IMcpServerHandlers {
    private readonly _name: string;
    private readonly _options: IMcpServerOptions;
    private readonly _initializer: IMcpInitializer | undefined;

    /**
     * The active message handler. Defaults to `this` (self-routing).
     * Can be replaced by a custom {@link IMcpServerHandlers} via the builder.
     */
    private readonly _handlers: IMcpServerHandlers;

    /**
     * The transport this server speaks through, supplied at construction.
     *
     * Optional so the class can be used as a pure request handler, calling
     * `initialize()`, `toolsList()` and friends directly, without a connection.
     * {@link start} is what requires one.
     */
    private readonly _providedTransport: IMessageTransport | undefined;

    private _transport: IMessageTransport | null = null;
    private _isRunning = false;

    /**
     * Set to true when the client sends `notifications/initialized`, signalling that
     * the session handshake is complete and the client is ready to issue requests.
     */
    private _sessionReady = false;

    /**
     * The MCP protocol revision agreed during the last `initialize` handshake.
     * Reset on disconnect so a reconnecting client renegotiates from scratch.
     */
    private _protocolVersion: string | undefined;

    /** Handle for the pending idle-timeout timer, if active. */
    private _idleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Registered behavior types, keyed by namespace. */
    private readonly _behaviors = new Map<string, IMcpBehavior>();
    private readonly _resourceIndex = new Map<string, IMcpRuntimeOperations>();

    /**
     * Unsubscribe handles for each behavior's `onGrammarsChanged` event.
     * Cleared in {@link unregister} and {@link stop} so a hot-reloading
     * behavior cannot leak its emitter into a stopped server.
     */
    private readonly _behaviorGrammarUnsubs = new Map<string, Unsubscribe>();

    // ── Grammar ──────────────────────────────────────────────────────────────

    /** Named grammars registered via the builder, keyed by a user-defined string. */
    private readonly _grammars: Map<string, McpGrammar>;

    /** Resolves a connecting client's identity to a grammar key. */
    private readonly _grammarResolver: McpGrammarResolver | undefined;

    /**
     * The grammar selected for the current session during the `initialize` handshake.
     * Applied on top of behaviour fallback descriptions when responding to `tools/list`.
     * Reset to `undefined` on disconnect so the next session starts clean.
     */
    private _sessionGrammar: McpGrammar | undefined;

    /** Tracks the grammar key resolved for the current session so the store change handler can check relevance. */
    private _currentGrammarKey: string | undefined;

    // ── Grammar Store ────────────────────────────────────────────────────────

    /** Optional shared grammar store for runtime grammar mutations. */
    private readonly _grammarStore: McpGrammarStore | undefined;

    /** Unsubscribe handle for the grammar store change listener. */
    private _storeUnsubscribe: Unsubscribe | undefined;

    constructor(
        name: string,
        options: IMcpServerOptions,
        initializer?: IMcpInitializer,
        handlers?: IMcpServerHandlers,
        grammars?: Map<string, McpGrammar>,
        grammarResolver?: McpGrammarResolver,
        transport?: IMessageTransport,
        grammarStore?: McpGrammarStore
    ) {
        this._name = name;
        this._options = options;
        this._initializer = initializer;
        // If no custom handlers provided, the server routes messages itself.
        this._handlers = handlers ?? this;
        this._grammars = grammars ?? new Map();
        this._grammarResolver = grammarResolver;
        this._providedTransport = transport;
        this._grammarStore = grammarStore;

        // Subscribe to grammar store changes so the session grammar can be
        // re-merged and clients notified when a profile is updated at runtime.
        if (this._grammarStore) {
            this._storeUnsubscribe = this._grammarStore.onChanged.subscribe((event: McpGrammarStoreChangeEvent) => {
                this._onGrammarStoreChanged(event);
            });
        }
    }

    // -------------------------------------------------------------------------
    // IMcpServer, identity & state
    // -------------------------------------------------------------------------

    get name(): string {
        return this._name;
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    get isSessionReady(): boolean {
        return this._sessionReady;
    }

    /**
     * The MCP protocol revision negotiated for the current session, or
     * `undefined` before the first `initialize` and after a disconnect.
     */
    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    // -------------------------------------------------------------------------
    // IMcpServer, lifecycle
    // -------------------------------------------------------------------------

    /**
     * Opens the transport and starts serving.
     * Resolves once the transport reports itself open, rejects on the first error.
     * Safe to call again after {@link stop}.
     *
     * @throws {Error} when the server was built without a transport.
     */
    start(): Promise<void> {
        if (!this._providedTransport) {
            return Promise.reject(new Error("McpServer: no transport was provided, pass one to the constructor or use McpServerBuilder.withTransport()"));
        }
        return this._connect(this._providedTransport);
    }

    /**
     * Closes the transport and stops serving.
     * Safe to call more than once.
     */
    async stop(): Promise<void> {
        this._clearIdleTimer();
        this._storeUnsubscribe?.();
        this._storeUnsubscribe = undefined;
        for (const unsub of this._behaviorGrammarUnsubs.values()) unsub();
        this._behaviorGrammarUnsubs.clear();
        this._transport?.close();
        this._transport = null;
        this._isRunning = false;
    }

    // -------------------------------------------------------------------------
    // IMcpServer, behavior & instance management
    // -------------------------------------------------------------------------

    register(...behavior: IMcpBehavior[]): IMcpServer {
        if (behavior.length !== 0) {
            for (const b of behavior) {
                this._behaviors.set(b.namespace, b);
                for (const r of b.getResources()) {
                    this._resourceIndex.set(r.uri, b);
                }
                // Subscribe to per-behavior grammar invalidations so a
                // hot-reload triggers a session re-merge + tools/list_changed.
                if (b.onGrammarsChanged) {
                    const unsub = b.onGrammarsChanged.subscribe(() => this._onBehaviorGrammarsChanged());
                    this._behaviorGrammarUnsubs.set(b.namespace, unsub);
                }
            }
            this._notifyResourcesListChanged();
        }
        return this;
    }

    unregister(...behavior: IMcpBehavior[]): IMcpServer {
        if (behavior.length !== 0) {
            for (const b of behavior) {
                this._behaviors.delete(b.namespace);
                for (const r of b.getResources()) {
                    this._resourceIndex.delete(r.uri);
                }
                this._behaviorGrammarUnsubs.get(b.namespace)?.();
                this._behaviorGrammarUnsubs.delete(b.namespace);
            }
            this._notifyResourcesListChanged();
        }
        return this;
    }

    // -------------------------------------------------------------------------
    // IMcpServerHandlers, default MCP method implementations
    // -------------------------------------------------------------------------

    /**
     * Handles the `initialize` handshake.
     * Delegates identity to {@link IMcpInitializer} if one was provided,
     * then merges with capabilities derived from registered behaviors.
     *
     * The protocol revision is negotiated here: the revision the client asked
     * for is echoed back when this server supports it, otherwise the newest
     * supported revision is returned, as the MCP lifecycle spec requires. An
     * initializer that returns an explicit `protocolVersion` pins the answer
     * and skips negotiation.
     *
     * Also resolves the session grammar from the grammar map using the
     * configured {@link McpGrammarResolver}, if any.
     */
    initialize(req: JsonRpcRequest): JsonRpcResponse {
        const params = req.params as { protocolVersion?: string; clientInfo?: McpClientInfo; capabilities?: McpClientCapabilities } | undefined;

        const clientInfo = params?.clientInfo ?? { name: "unknown", version: "0.0.0" };
        const capabilities = params?.capabilities;

        const identity = this._initializer ? this._initializer.initialize(clientInfo, capabilities ?? {}) : { serverInfo: { name: this._name, version: "0.0.0" } };

        // An initializer may pin a revision; otherwise negotiate against the
        // set this server accepts.
        this._protocolVersion = identity.protocolVersion ?? negotiateProtocolVersion(params?.protocolVersion, this._options.protocolVersions);

        // Resolve the session grammar by walking the candidate chain
        // returned by the resolver and picking the first key that yields
        // a non-empty merge across the four layers
        // (behavior → adapter → static → store).
        const raw = this._grammarResolver?.(clientInfo, capabilities);
        const candidates: readonly string[] = !raw ? [] : typeof raw === "string" ? [raw] : raw;

        let matchedKey: string | undefined;
        let matchedGrammar: McpGrammar | undefined;
        for (const candidate of candidates) {
            const merged = this._composeSessionGrammar(candidate);
            if (merged) {
                matchedKey = candidate;
                matchedGrammar = merged;
                break;
            }
        }
        this._currentGrammarKey = matchedKey;
        this._sessionGrammar = matchedGrammar;

        const result: McpInitializeResult = { ...identity, protocolVersion: this._protocolVersion, capabilities: this._deriveCapabilities() };

        return Mcp.initializeResult(req.id, result);
    }

    /**
     * Handles `ping`. The spec requires an empty result and a prompt answer:
     * the peer uses it to tell a live connection from a stale one.
     */
    ping(req: JsonRpcRequest): JsonRpcResponse {
        return Mcp.pingResult(req.id);
    }

    /**
     * Builds the session grammar for a single candidate key by stacking
     * the four layers in priority order (low → high):
     *
     *   1. Behavior-owned (per behavior, merged in registration order)
     *   2. Adapter-owned (per behavior's adapter)
     *   3. Builder-registered static grammar
     *   4. Runtime grammar store
     *
     * Returns `undefined` when no layer contributes anything for this
     * key, so the caller knows to try the next candidate in the chain.
     */
    private _composeSessionGrammar(key: string): McpGrammar | undefined {
        const layers: McpGrammar[] = [];
        for (const behavior of this._behaviors.values()) {
            const bg = behavior.getGrammar?.(key);
            if (bg) layers.push(bg);
            // McpBehavior exposes its adapter via a `adapter` getter. Other
            // IMcpBehavior implementations may not; probe defensively.
            const adapter = (behavior as { adapter?: { getGrammar?(k: string): McpGrammar | undefined } }).adapter;
            const ag = adapter?.getGrammar?.(key);
            if (ag) layers.push(ag);
        }
        const staticGrammar = this._grammars.get(key);
        if (staticGrammar) layers.push(staticGrammar);
        const storeGrammar = this._grammarStore?.get(key);
        if (storeGrammar) layers.push(storeGrammar);

        return layers.length > 0 ? McpGrammar.merge(...layers) : undefined;
    }

    /**
     * Handles `resources/templates/list`.
     * Collects URI templates from all registered behavior types that declare one.
     * Each unique namespace contributes at most one template entry.
     *
     * If a session grammar was resolved during `initialize`, template `name`
     * and `description` are patched before the response is sent.
     */
    resourcesTemplatesList(req: JsonRpcRequest): JsonRpcResponse {
        const templates: McpResourceTemplate[] = [];
        for (const behavior of this._behaviors.values()) {
            templates.push(...behavior.getResourceTemplates());
        }
        const patched = this._sessionGrammar ? this._applyTemplateGrammar(templates, this._sessionGrammar) : templates;
        return Mcp.resourcesTemplatesListResult(req.id, patched);
    }

    /**
     * Handles `resources/list`.
     * Returns the union of all live {@link IMcpBehaviorInstance} resources.
     *
     * If a session grammar was resolved during `initialize`, resource `name`
     * and `description` are patched before the response is sent.
     */
    resourcesList(req: JsonRpcRequest): JsonRpcResponse {
        const resources = Array.from(this._behaviors.values()).flatMap((i) => i.getResources());
        const patched = this._sessionGrammar ? this._applyResourceGrammar(resources, this._sessionGrammar) : resources;
        return Mcp.resourcesListResult(req.id, patched);
    }

    /**
     * Handles `resources/read`.
     *
     * Resolution order:
     * 1. Exact match in `_resourceIndex` (static resource URIs, O(1)).
     * 2. Template match: scan each behavior's URI templates and test the
     *    requested URI against each `{variable}` pattern (RFC 6570 subset).
     *
     * Returns a `-32002` error if neither lookup finds a handler.
     */
    async resourcesRead(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { uri?: string } | undefined;
        const uri = params?.uri;

        if (!uri) return Mcp.invalidParams(req.id, "Missing required parameter: uri");
        const instance = this._resourceIndex.get(uri) ?? this._matchTemplate(uri);
        if (!instance) return Mcp.resourceNotFound(req.id, uri);
        const r = await instance.readResourceAsync(uri);
        if (!r) return Mcp.resourceNotFound(req.id, uri);

        return Mcp.resourcesReadResult(req.id, r);
    }

    /**
     * Handles `tools/list`.
     * Deduplicates tools by name: all instances of the same behavior expose
     * identical schemas, so each tool is listed only once.
     * The target instance is identified at call time via the `uri` argument.
     *
     * If a session grammar was resolved during `initialize`, tool and property
     * descriptions are patched before the response is sent.
     */
    toolsList(req: JsonRpcRequest): JsonRpcResponse {
        const tools: McpTool[] = [];

        for (const behavior of this._behaviors.values()) {
            for (const tool of behavior.getTools()) {
                tools.push(tool);
            }
        }

        const patched = this._sessionGrammar ? this._applyGrammar(tools, this._sessionGrammar) : tools;

        return Mcp.toolsListResult(req.id, patched);
    }

    /**
     * Handles `tools/call`.
     *
     * Routing strategy (in order):
     * 1. If `arguments.uri` is present, route directly to that instance (fast path).
     *    Behaviors should declare `uri` as a required field in their tool `inputSchema`.
     * 2. Otherwise, scan all instances for the first one that declares the tool (fallback
     *    for single-instance scenarios where a URI is not needed).
     *
     * A name no behavior declares is reported as an unknown tool (`-32602`),
     * which is the protocol error the spec defines for it.
     */
    async toolsCallAsync(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;

        const name = params?.name;
        if (!name) return Mcp.invalidParams(req.id, "Missing required parameter: name");

        const args = params?.arguments ?? {};
        const uri = args["uri"] as string | undefined;

        if (uri) {
            // Fast path: URI provided, route directly to the matching resource.
            const r = this._resourceIndex.get(uri) ?? this._matchTemplate(uri);
            if (!r) return Mcp.instanceNotFound(req.id, uri);
            return this._callTool(req, r, uri, name, args);
        }

        // Fallback for singleton behaviors: scan all behaviors for the first one
        // that declares the requested tool. Behaviors that ignore the URI (e.g.
        // SpkResearchBehavior, SpkProjectBehavior) work correctly with an empty URI.
        for (const behavior of this._behaviors.values()) {
            if (behavior.getTools().some((t) => t.name === name)) {
                return this._callTool(req, behavior, "", name, args);
            }
        }
        return Mcp.toolNotFound(req.id, name);
    }

    // -------------------------------------------------------------------------
    // Grammar patching
    // -------------------------------------------------------------------------

    /**
     * Applies a grammar layer on top of resource entries returned by behaviours.
     * Returns new resource objects when there is at least one override; the
     * originals (which may be cached) are never mutated.
     *
     * The grammar may override:
     * - The resource `name`
     * - The resource `title`
     * - The resource `description`
     */
    private _applyResourceGrammar(resources: McpResource[], grammar: McpGrammar): McpResource[] {
        return resources.map((r) => {
            const name = grammar.getResourceName(r.uri);
            const title = grammar.getResourceTitle(r.uri);
            const description = grammar.getResourceDescription(r.uri);
            if (name === undefined && title === undefined && description === undefined) return r;
            return {
                ...r,
                name: name ?? r.name,
                title: title ?? r.title,
                description: description ?? r.description,
            };
        });
    }

    /**
     * Applies a grammar layer on top of resource template entries returned by
     * behaviours. Returns new template objects when there is at least one
     * override; the originals are never mutated.
     *
     * The grammar may override:
     * - The template `name`
     * - The template `title`
     * - The template `description`
     *
     * Lookup key is the `uriTemplate` string.
     */
    private _applyTemplateGrammar(templates: McpResourceTemplate[], grammar: McpGrammar): McpResourceTemplate[] {
        return templates.map((t) => {
            const name = grammar.getResourceTemplateName(t.uriTemplate);
            const title = grammar.getResourceTemplateTitle(t.uriTemplate);
            const description = grammar.getResourceTemplateDescription(t.uriTemplate);
            if (name === undefined && title === undefined && description === undefined) return t;
            return {
                ...t,
                name: name ?? t.name,
                title: title ?? t.title,
                description: description ?? t.description,
            };
        });
    }

    /**
     * Applies a grammar layer on top of tool schemas returned by behaviours.
     * Returns new tool objects: the originals (which may be cached) are never mutated.
     *
     * For each tool the grammar may override:
     * - The tool-level `title` and `description`
     * - Individual property `description` fields inside `inputSchema.properties`
     *   (supports dot-notation for nested objects, e.g. `"patch.position"`)
     */
    private _applyGrammar(tools: McpTool[], grammar: McpGrammar): McpTool[] {
        return tools.map((tool) => {
            const toolTitle = grammar.getToolTitle(tool.name);
            const toolDesc = grammar.getToolDescription(tool.name);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const schema = tool.inputSchema as any;
            const patchedSchema = schema?.properties ? this._patchProperties(tool.name, schema, grammar) : schema;

            if (!toolTitle && !toolDesc && patchedSchema === schema) {
                return tool; // nothing to patch
            }

            return {
                ...tool,
                title: toolTitle ?? tool.title,
                description: toolDesc ?? tool.description,
                inputSchema: patchedSchema,
            };
        });
    }

    /**
     * Recursively patches property descriptions in a JSON schema object.
     * Returns the original schema reference when no patches are needed,
     * or a shallow copy with patched `description` fields.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _patchProperties(toolName: string, schema: any, grammar: McpGrammar, prefix = ""): any {
        const props = schema.properties;
        if (!props) return schema;

        let patched = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newProps: Record<string, any> = {};

        for (const [key, value] of Object.entries(props)) {
            const qualifiedKey = prefix ? `${prefix}.${key}` : key;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let prop = value as any;

            // Check for a grammar override on this property
            const propDesc = grammar.getPropertyDescription(toolName, qualifiedKey);
            if (propDesc !== undefined) {
                prop = { ...prop, description: propDesc };
                patched = true;
            }

            // Recurse into nested object properties
            if (prop.properties) {
                const nested = this._patchProperties(toolName, prop, grammar, qualifiedKey);
                if (nested !== prop) {
                    prop = nested;
                    patched = true;
                }
            }

            newProps[key] = prop;
        }

        if (!patched) return schema;
        return { ...schema, properties: newProps };
    }

    // -------------------------------------------------------------------------
    // Transport connection management
    // -------------------------------------------------------------------------

    /** Wires the transport's event handlers and opens it. */
    private _connect(transport: IMessageTransport): Promise<void> {
        return new Promise((resolve, reject) => {
            transport.onOpen = () => {
                this._transport = transport;
                this._isRunning = true;
                resolve();
            };

            transport.onError = (error: Error) => {
                // Only reject the initial promise; subsequent errors are handled via onClose.
                if (!this._isRunning) {
                    reject(new Error(`McpServer: transport failed to open, ${error.message}`));
                }
            };

            transport.onClose = () => this._onDisconnect();

            transport.onMessage = (data: string) => {
                this._resetIdleTimer();
                void this._handleMessage(data);
            };

            // Open the transport. `connect()` is not part of IMessageTransport ,
            // some transports are handed over already open: so probe for it
            // rather than testing for a specific class, which would tie the
            // server to one transport implementation.
            if ("connect" in transport && typeof (transport as { connect: unknown }).connect === "function") {
                (transport as { connect(): void }).connect();
            }
        });
    }

    /**
     * Called whenever the transport closes, cleanly or not.
     *
     * The session is dropped, not rebuilt: reconnecting belongs to the
     * transport, which is the only party that knows what that means for its
     * medium. When it reopens, the client renegotiates from `initialize`.
     */
    private _onDisconnect(): void {
        this._isRunning = false;
        this._transport = null;
        this._sessionReady = false; // handshake must be repeated on reconnection
        this._protocolVersion = undefined; // revision must be renegotiated on reconnection
        this._sessionGrammar = undefined; // grammar must be re-resolved on reconnection
        this._currentGrammarKey = undefined;
        this._clearIdleTimer();
    }

    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------

    /**
     * Entry point for every raw WebSocket message.
     * Distinguishes JSON-RPC notifications (no `id`) from requests (has `id`):
     * - Notifications are handled but never answered.
     * - Requests are dispatched and produce a response sent back over the socket.
     */
    private async _handleMessage(data: string): Promise<void> {
        let msg: JsonRpcRequest | JsonRpcNotification;
        try {
            msg = JSON.parse(data) as JsonRpcRequest | JsonRpcNotification;
        } catch {
            // Per JSON-RPC 2.0 spec, id is null when the request cannot be parsed.
            this._send(Mcp.parseError());
            return;
        }

        // MCP dropped JSON-RPC batching in revision 2025-06-18. Answer explicitly
        // instead of letting an array fall through and be silently discarded.
        if (Array.isArray(msg)) {
            this._send(Mcp.invalidRequest(null, "JSON-RPC batching is not supported"));
            return;
        }

        // Notifications carry no `id`, handle silently, never respond.
        if (!("id" in msg) || msg.id === null) {
            this._handleNotification(msg as JsonRpcNotification);
            return;
        }

        this._send(await this._dispatch(msg as JsonRpcRequest));
    }

    /**
     * Handles JSON-RPC notifications sent by the client.
     * Per the MCP spec, no response is ever sent for notifications.
     * Unknown notification methods are silently ignored.
     */
    private _handleNotification(notification: JsonRpcNotification): void {
        switch (notification.method) {
            case "notifications/initialized":
                // Client has finished its own initialisation and is ready to send requests.
                this._sessionReady = true;
                break;
            // All other notifications are intentionally ignored.
        }
    }

    /**
     * Routes a parsed JSON-RPC request to the correct handler method.
     * Unknown methods receive a `-32601 Method not found` error.
     */
    private async _dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        switch (req.method) {
            case "initialize":
                return this._handlers.initialize(req);
            case "resources/list":
                return this._handlers.resourcesList(req);
            case "resources/templates/list":
                return this._handlers.resourcesTemplatesList(req);
            case "resources/read":
                return this._handlers.resourcesRead(req);
            case "tools/list":
                return this._handlers.toolsList(req);
            case "tools/call":
                return this._handlers.toolsCallAsync(req);
            case "ping":
                // Custom handlers may leave `ping` out; answering it is mandatory,
                // so fall back to the empty result the spec defines.
                return this._handlers.ping?.(req) ?? Mcp.pingResult(req.id);
            default:
                return Mcp.methodNotFound(req.id, req.method);
        }
    }

    // -------------------------------------------------------------------------
    // Idle timeout
    // -------------------------------------------------------------------------

    /**
     * Resets the idle-timeout timer on each incoming message.
     * When the timer expires the connection is closed, which may trigger reconnection.
     */
    private _resetIdleTimer(): void {
        if (!this._options.idleTimeoutMs) return;
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            this._transport?.close();
        }, this._options.idleTimeoutMs);
    }

    private _clearIdleTimer(): void {
        if (this._idleTimer !== null) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    // -------------------------------------------------------------------------
    // Shared helpers
    // -------------------------------------------------------------------------

    /**
     * Sends a `notifications/resources/list_changed` notification to the client.
     * Only fires when the session is fully initialized and the WebSocket is open.
     */
    private _notifyResourcesListChanged(): void {
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.resourcesListChanged());
    }

    /**
     * Sends a `notifications/tools/list_changed` notification to the client.
     * Only fires when the session is fully initialized and the WebSocket is open.
     */
    private _notifyToolsListChanged(): void {
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.toolsListChanged());
    }

    /**
     * Reacts to a grammar store mutation. If the changed profile is the one
     * currently active for this session, re-merges the session grammar
     * from all four layers and notifies the client so it can re-fetch
     * `tools/list`.
     */
    private _onGrammarStoreChanged(event: McpGrammarStoreChangeEvent): void {
        if (!this._currentGrammarKey || event.profileId !== this._currentGrammarKey) return;
        this._sessionGrammar = this._composeSessionGrammar(this._currentGrammarKey);
        this._notifyToolsListChanged();
    }

    /**
     * Reacts to a behavior advertising that its grammar map changed
     * (hot-reload, runtime mutation). Re-merges the session grammar for
     * the currently active key and notifies the client. No-op when no
     * session is active or the active key cannot be re-merged.
     */
    private _onBehaviorGrammarsChanged(): void {
        if (!this._currentGrammarKey) return;
        this._sessionGrammar = this._composeSessionGrammar(this._currentGrammarKey);
        this._notifyToolsListChanged();
    }

    /**
     * Serializes and sends a JSON-RPC notification over the transport, if open.
     * Unlike {@link _send}, this accepts a notification (no `id`) rather than a response.
     */
    private _sendNotification(notification: { jsonrpc: "2.0"; method: string; params?: unknown }): void {
        if (this._transport?.isOpen) {
            this._transport.send(JSON.stringify(notification));
        }
    }

    /**
     * Derives server capabilities from what the registered behaviors actually
     * expose. A capability is only advertised when at least one behavior
     * contributes to it: a tools-only server must not claim `resources`, or a
     * client would list an empty set it was told to expect.
     */
    private _deriveCapabilities(): McpServerCapabilities {
        let hasResources = false;
        let hasTools = false;

        for (const behavior of this._behaviors.values()) {
            if (!hasResources && (behavior.getResources().length > 0 || behavior.getResourceTemplates().length > 0)) hasResources = true;
            if (!hasTools && behavior.getTools().length > 0) hasTools = true;
            if (hasResources && hasTools) break;
        }

        const capabilities: McpServerCapabilities = {};
        if (hasResources) capabilities.resources = { listChanged: true };
        if (hasTools) capabilities.tools = { listChanged: true };
        return capabilities;
    }

    /**
     * Finds the behavior whose URI template matches `uri`.
     *
     * Converts each `{variable}` placeholder to a regex segment that matches
     * any non-slash sequence, then tests the full URI against the pattern.
     * Returns the first matching behavior, or `undefined` when none match.
     *
     * Example: template `app://camera/{cameraId}` matches `app://camera/main`.
     */
    private _matchTemplate(uri: string): IMcpRuntimeOperations | undefined {
        for (const behavior of this._behaviors.values()) {
            for (const { uriTemplate } of behavior.getResourceTemplates()) {
                // Escape regex meta-chars in the template, then replace {var} with a
                // segment wildcard.  Anchors ensure the whole URI must match.
                const pattern = uriTemplate
                    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape special chars
                    .replace(/\\\{[^}]+\\\}/g, "[^/]+"); // un-escape & expand {var}
                if (new RegExp(`^${pattern}$`).test(uri)) {
                    return behavior;
                }
            }
        }
        return undefined;
    }

    /**
     * Invokes a tool on a specific instance and wraps the result as a JSON-RPC response.
     *
     * A throwing tool is reported as a tool execution error (`isError: true`)
     * rather than a JSON-RPC error. The spec asks for this because execution
     * and input-validation failures carry actionable feedback the model can use
     * to self-correct, whereas a protocol error is opaque to it.
     */
    private async _callTool(req: JsonRpcRequest, instance: IMcpRuntimeOperations, uri: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
        try {
            const result = await instance.executeToolAsync(uri, name, args);
            return Mcp.toolCallResult(req.id, result);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Tool execution failed";
            return Mcp.toolCallResult(req.id, McpToolResults.error(`${name}: ${message}`));
        }
    }

    /** Sends a serialized JSON-RPC response over the transport, if open. */
    private _send(response: JsonRpcResponse): void {
        if (this._transport?.isOpen) {
            this._transport.send(JSON.stringify(response));
        }
    }
}
