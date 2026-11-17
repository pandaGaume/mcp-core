import type {
    IMessageTransport,
    IMcpBehavior,
    IMcpInitializer,
    IMcpRequestContext,
    IMcpRuntimeOperations,
    IMcpServer,
    IMcpServerHandlers,
    IMcpServerOptions,
    IMcpExtensionHost,
    IMcpServerExtension,
    McpExtensionHandler,
    McpExtensionNotificationHandler,
    McpGrammarResolver,
} from "../interfaces";
import type {
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
    McpClientCapabilities,
    McpClientInfo,
    McpCompletion,
    McpCompletionArgument,
    McpCompletionReference,
    McpInitializeResult,
    McpLoggingLevel,
    McpPrompt,
    McpResource,
    McpResourceTemplate,
    McpServerCapabilities,
    McpServerIdentity,
    McpTool,
} from "../interfaces";
import { MCP_LOGGING_LEVELS } from "../interfaces";
import type { IEventEmitter, IEventSource, Unsubscribe } from "../interfaces/eventSource";
import { createEventEmitter } from "../interfaces/eventSource";
import { GRAMMAR_PHRASES_URI, McpGrammar } from "../mcp.grammar";
import type { McpGrammarStore, McpGrammarStoreChangeEvent } from "../mcp.grammarStore";
import {
    MCP_CACHEABLE_METHODS,
    MCP_ERROR_CODES,
    MCP_META,
    MCP_SERVER_NOTIFICATION_METHODS,
    MCP_SERVER_REQUEST_METHODS,
    MCP_STATELESS_PROTOCOL_VERSIONS,
    MCP_STATELESS_REMOVED_METHODS,
    MCP_STATELESS_REQUEST_METHODS,
    negotiateProtocolVersion,
} from "../mcp.protocol";
import { McpToolResults } from "../mcp.toolResult";
import { jsonRpcError, jsonRpcOk, Mcp } from "./jsonrpc.helpers";

/**
 * An {@link IEventEmitter} that also reports how many handlers are subscribed.
 *
 * Needed because {@link McpServer} falls back to `console.error` when a
 * transport error has no subscriber, and the plain emitter cannot say whether
 * anyone is listening. Merely reading the `onTransportError` property must not
 * count as listening, otherwise a caller that only inspects the surface would
 * silence the fallback.
 */
interface ICountingEventEmitter<T> extends IEventEmitter<T> {
    /** Number of currently subscribed handlers. */
    readonly size: number;
}

/** Builds an {@link ICountingEventEmitter} on top of the package's plain emitter. */
function createCountingEventEmitter<T>(): ICountingEventEmitter<T> {
    const inner = createEventEmitter<T>();
    let size = 0;

    return {
        get size(): number {
            return size;
        },

        subscribe(handler: (value: T) => void): Unsubscribe {
            const unsubscribe = inner.subscribe(handler);
            size++;
            // The returned handle must be idempotent: callers do unsubscribe
            // twice, and a double decrement would resurrect the console
            // fallback while a live handler is still attached.
            let released = false;
            return () => {
                if (released) return;
                released = true;
                size--;
                unsubscribe();
            };
        },

        emit(value: T): void {
            inner.emit(value);
        },

        clear(): void {
            inner.clear();
            size = 0;
        },
    };
}

/** The spec caps `completion.values` at 100 entries per answer. */
const MAX_COMPLETION_VALUES = 100;

/** Level below which {@link McpServer.log} stays silent until the client calls `logging/setLevel`. */
const DEFAULT_LOGGING_LEVEL: McpLoggingLevel = "info";

/** `true` when `value` is one of the RFC 5424 severities the spec names. */
function isLoggingLevel(value: unknown): value is McpLoggingLevel {
    return typeof value === "string" && (MCP_LOGGING_LEVELS as readonly string[]).includes(value);
}

/**
 * Builds the {@link IMcpRequestContext} a runtime operation receives.
 *
 * `params._meta` is copied (shallowly) and frozen, so an adapter cannot alter
 * what another one, or the server, sees of the same request. A `_meta` that is
 * not a plain object is not metadata the spec defines, and is left out.
 */
function requestContextOf(req: JsonRpcRequest, sequence: number, signal: AbortSignal | undefined, extra: Partial<IMcpRequestContext> = {}): IMcpRequestContext {
    const meta = (req.params as { _meta?: unknown } | undefined)?._meta;
    const usable = typeof meta === "object" && meta !== null && !Array.isArray(meta);
    return Object.freeze({
        sequence,
        requestId: req.id,
        method: req.method,
        ...(usable ? { meta: Object.freeze({ ...(meta as Record<string, unknown>) }) } : {}),
        ...(signal ? { signal } : {}),
        ...extra,
    });
}

/** `true` for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the server knows about the client while serving one request: the
 * session's view for a client that sent `initialize`, the request's own
 * `_meta` for a stateless one (2026-07-28 and later).
 */
interface IRequestScope {
    readonly stateless: boolean;
    readonly protocolVersion: string | undefined;
    readonly clientCapabilities: McpClientCapabilities | undefined;
    readonly clientInfo: McpClientInfo | undefined;
    readonly grammar: McpGrammar | undefined;
    readonly grammarKey: string | undefined;
    /** Stateless only: the level the request asked `notifications/message` at, if it did. */
    readonly logLevel?: McpLoggingLevel;
    /** Stateless only: the server identity for this client. */
    readonly serverInfo?: McpServerIdentity["serverInfo"];
    readonly instructions?: string;
}

/** The notifications a `subscriptions/listen` asks for. */
interface ISubscriptionFilter {
    toolsListChanged?: boolean;
    promptsListChanged?: boolean;
    resourcesListChanged?: boolean;
    resourceSubscriptions?: string[];
    /** Flags extensions add (`eventsListChanged`, ...). */
    [flag: string]: boolean | string[] | undefined;
}

/** One open `subscriptions/listen`. */
interface IListen {
    readonly id: string | number;
    readonly filter: ISubscriptionFilter;
    /** Ends the listen: settles its pending dispatch without a second answer. */
    finish(): void;
}

/**
 * Key of a request in the in-flight map. JSON-RPC ids are strings or numbers,
 * and `1` and `"1"` are two different requests.
 */
function inflightKey(id: string | number): string {
    return `${typeof id}:${id}`;
}

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

    /** Extensions by identifier, in registration order. */
    private readonly _extensions = new Map<string, IMcpServerExtension>();
    /** Request methods added by extensions, with their owner. */
    private readonly _extensionMethods = new Map<string, { readonly extension: IMcpServerExtension; readonly handler: McpExtensionHandler }>();
    /** Client notifications added by extensions, with their owner. */
    private readonly _extensionNotifications = new Map<string, { readonly extension: IMcpServerExtension; readonly handler: McpExtensionNotificationHandler }>();
    /** The view of this server handed to extensions; created on first registration. */
    private _extensionHost: IMcpExtensionHost | undefined;

    /** The scope of each stateless request being served, keyed by the request object itself. */
    private readonly _statelessScopes = new WeakMap<JsonRpcRequest, IRequestScope>();
    /** Grammars composed for stateless requests, by key; cleared when a grammar changes. */
    private readonly _grammarCache = new Map<string, McpGrammar | null>();
    /** Open `subscriptions/listen` requests, by in-flight key. */
    private readonly _listens = new Map<string, IListen>();

    /** The capabilities the client declared at `initialize`, for the current session. */
    private _clientCapabilities: McpClientCapabilities | undefined;
    /** The client's identity from `initialize`, for the current session. */
    private _clientInfo: McpClientInfo | undefined;
    private readonly _resourceIndex = new Map<string, IMcpRuntimeOperations>();

    /**
     * Unsubscribe handles for each behavior's `onGrammarsChanged` event.
     * Cleared in {@link unregister} and {@link stop} so a hot-reloading
     * behavior cannot leak its emitter into a stopped server.
     */
    private readonly _behaviorGrammarUnsubs = new Map<string, Unsubscribe>();

    /**
     * Unsubscribe handles for each behavior's change events
     * (`onResourceUpdated`, `onResourcesListChanged`, `onPromptsChanged`).
     *
     * Kept across {@link stop} and released only by {@link unregister}: the
     * registration outlives any one connection, and a restarted server must
     * still hear its behaviors. Emitting while stopped is harmless, since every
     * send is a no-op without an open transport.
     */
    private readonly _behaviorEventUnsubs = new Map<string, Unsubscribe[]>();

    // ── Session state reset on disconnect ────────────────────────────────────

    /**
     * URIs this session subscribed to with `resources/subscribe`. Matched
     * exactly, byte for byte: the spec defines no URI normalization, and
     * inventing one would deliver a notification the client did not ask for.
     */
    private readonly _subscriptions = new Set<string>();

    /** Minimum severity {@link log} emits, as set by `logging/setLevel`. */
    private _logLevel: McpLoggingLevel = DEFAULT_LOGGING_LEVEL;

    /** Monotonic correlation sequence for runtime requests served by this instance. */
    private _requestSequence = 0;

    /**
     * Requests being served, by JSON-RPC id, with the controller that cancels
     * them. `initialize` is never listed: the spec forbids cancelling it.
     */
    private readonly _inflight = new Map<string, AbortController>();

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

    // ── Transport events ─────────────────────────────────────────────────────

    /**
     * Emitter behind {@link onTransportError}. Created on first access, like the
     * client's own change emitters, so a server nobody observes allocates nothing.
     */
    private _onTransportError: ICountingEventEmitter<Error> | undefined;

    /** Emitter behind {@link onDisconnected}. Created on first access. */
    private _onDisconnected: ICountingEventEmitter<void> | undefined;

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

    /** The capabilities the client declared at `initialize`, `undefined` outside a session. */
    get clientCapabilities(): McpClientCapabilities | undefined {
        return this._clientCapabilities;
    }

    /** The settings the client declared for `extensionId`, `undefined` when it did not declare it. */
    clientExtension(extensionId: string): Readonly<Record<string, unknown>> | undefined {
        const settings = this._clientCapabilities?.extensions?.[extensionId];
        return typeof settings === "object" && settings !== null && !Array.isArray(settings) ? settings : undefined;
    }

    /**
     * Transport-level errors reported after the transport opened.
     *
     * See {@link IMcpServer.onTransportError}. When no handler is subscribed the
     * error is written to `console.error` instead, so a refused slot or a broken
     * socket is never swallowed.
     */
    get onTransportError(): IEventSource<Error> {
        if (!this._onTransportError) this._onTransportError = createCountingEventEmitter<Error>();
        return this._onTransportError;
    }

    /**
     * Fires when the transport closes and the session state is dropped.
     * See {@link IMcpServer.onDisconnected}.
     */
    get onDisconnected(): IEventSource<void> {
        if (!this._onDisconnected) this._onDisconnected = createCountingEventEmitter<void>();
        return this._onDisconnected;
    }

    // -------------------------------------------------------------------------
    // IMcpServer, lifecycle
    // -------------------------------------------------------------------------

    /**
     * Opens the transport and starts serving.
     *
     * Resolves once **the transport reports itself open**, and rejects only on an
     * error raised before that point. Resolving is therefore not a guarantee that
     * a remote peer accepted the connection: with a tunnelled transport (a broker
     * slot, a relay, a reverse proxy) the socket is open long before the peer has
     * said whether it will serve this server at all, and a refusal arrives as an
     * ordinary post-open transport error. Do not log "connected" here; log it when
     * the first `initialize` request arrives.
     *
     * Subscribe to {@link onTransportError} for everything that happens after the
     * transport is open, and to {@link onDisconnected} for the close.
     *
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
        // A server closing a subscription gracefully answers it (2026-07-28).
        for (const listen of [...this._listens.values()]) {
            this._send(jsonRpcOk(listen.id, { resultType: "complete", _meta: { [MCP_META.subscriptionId]: listen.id } }));
            listen.finish();
        }
        for (const extension of this._extensions.values()) extension.detach?.();
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
                // Re-registering a namespace replaces it; drop the old
                // subscriptions first or the replaced instance keeps talking.
                this._releaseBehaviorEvents(b.namespace);
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
                this._subscribeBehaviorEvents(b);
            }
            this._notifyResourcesListChanged();
            if (behavior.some((b) => b.getTools().length > 0)) this._notifyToolsListChanged();
            if (behavior.some((b) => (b.getPrompts?.().length ?? 0) > 0)) this.notifyPromptsListChanged();
        }
        return this;
    }

    /**
     * Takes an MCP extension: declares it under `capabilities.extensions`,
     * serves the methods and notifications it adds, and registers its
     * behaviors. Usually called through `McpServerBuilder.withExtension()`.
     *
     * @throws {Error} when the identifier is taken, or a method or
     * notification is a core one or already claimed by another extension.
     */
    registerExtension(extension: IMcpServerExtension): this {
        if (!extension.id) throw new Error("McpServer: an extension needs a non-empty id");
        if (this._extensions.has(extension.id)) throw new Error(`McpServer: extension "${extension.id}" is already registered`);
        const coreRequests = new Set(["initialize", ...Object.values(MCP_SERVER_REQUEST_METHODS).flat(), ...MCP_STATELESS_REQUEST_METHODS]);
        const coreNotifications = new Set(MCP_SERVER_NOTIFICATION_METHODS);
        const methods = Object.entries(extension.methods ?? {});
        const notifications = Object.entries(extension.notifications ?? {});
        // Validate everything before touching any table, so a refusal leaves the server as it was.
        for (const [method] of methods) {
            if (coreRequests.has(method)) throw new Error(`McpServer: extension "${extension.id}" cannot claim the core method "${method}"`);
            const owner = this._extensionMethods.get(method);
            if (owner) throw new Error(`McpServer: extension "${extension.id}" claims "${method}", already served by "${owner.extension.id}"`);
        }
        for (const [method] of notifications) {
            if (coreNotifications.has(method)) throw new Error(`McpServer: extension "${extension.id}" cannot claim the core notification "${method}"`);
            const owner = this._extensionNotifications.get(method);
            if (owner) throw new Error(`McpServer: extension "${extension.id}" claims "${method}", already handled by "${owner.extension.id}"`);
        }

        this._extensions.set(extension.id, extension);
        for (const [method, handler] of methods) this._extensionMethods.set(method, { extension, handler });
        for (const [method, handler] of notifications) this._extensionNotifications.set(method, { extension, handler });
        if (extension.behaviors?.length) this.register(...extension.behaviors);
        extension.attach?.(this._hostForExtensions());
        return this;
    }

    /** The extensions this server serves, in registration order. */
    get extensions(): readonly IMcpServerExtension[] {
        return [...this._extensions.values()];
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
                this._releaseBehaviorEvents(b.namespace);
            }
            this._notifyResourcesListChanged();
            if (behavior.some((b) => b.getTools().length > 0)) this._notifyToolsListChanged();
            if (behavior.some((b) => (b.getPrompts?.().length ?? 0) > 0)) this.notifyPromptsListChanged();
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
        this._clientInfo = clientInfo;
        this._clientCapabilities = capabilities ?? {};

        const identity = this._initializer ? this._initializer.initialize(clientInfo, capabilities ?? {}) : { serverInfo: { name: this._name, version: "0.0.0" } };

        // An initializer may pin a revision; otherwise negotiate against the
        // set this server accepts.
        this._protocolVersion = identity.protocolVersion ?? negotiateProtocolVersion(params?.protocolVersion, this._options.protocolVersions);

        // Resolve the session grammar by walking the candidate chain
        // returned by the resolver and picking the first key that yields
        // a non-empty merge across the four layers
        // (behavior → adapter → static → store).
        const { key: matchedKey, grammar: matchedGrammar } = this._resolveGrammar(clientInfo, capabilities, (key) => this._composeSessionGrammar(key));
        this._currentGrammarKey = matchedKey;
        this._sessionGrammar = matchedGrammar;

        // The session grammar may carry the server's own words: they fill what
        // the initializer left empty, so one wording covers the whole session.
        // The key that was matched travels in `_meta`, so a client can record
        // which wording it was given.
        const words = matchedGrammar;
        const serverInfo =
            words?.getServerDescription() && !identity.serverInfo.description ? { ...identity.serverInfo, description: words.getServerDescription() } : identity.serverInfo;
        const instructions = identity.instructions ?? words?.getServerInstructions();
        const result: McpInitializeResult = {
            ...identity,
            serverInfo,
            ...(instructions !== undefined ? { instructions } : {}),
            protocolVersion: this._protocolVersion,
            capabilities: this._deriveCapabilities(),
            ...(matchedKey !== undefined ? { _meta: { ...(identity._meta ?? {}), grammar: matchedKey } } : {}),
        };

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
        const grammar = this._scopeOf(req).grammar;
        const patched = grammar ? this._applyTemplateGrammar(templates, grammar) : templates;
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
        const grammar = this._scopeOf(req).grammar;
        const patched = grammar ? this._applyResourceGrammar(resources, grammar) : resources;
        // The session's phrases (1.2.0): listed only when the wording chosen for this session carries some.
        if (grammar?.hasPhrases())
            patched.push({
                uri: GRAMMAR_PHRASES_URI,
                name: "Phrases",
                description: "The sentences of this session's wording, by key, holes unfilled",
                mimeType: "application/json",
            });
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
        if (uri === GRAMMAR_PHRASES_URI) {
            // The phrases of the session's wording, as the grammar resolved at `initialize` carries them; none resolved, none served.
            const scope = this._scopeOf(req);
            if (!scope.grammar?.hasPhrases()) return Mcp.resourceNotFound(req.id, uri);
            const text = JSON.stringify({ grammar: scope.grammarKey, phrases: scope.grammar.getPhrases() });
            return Mcp.resourcesReadResult(req.id, { uri, mimeType: "application/json", text });
        }
        const instance = this._resourceIndex.get(uri) ?? this._matchTemplate(uri);
        if (!instance) return Mcp.resourceNotFound(req.id, uri);
        const r = await instance.readResourceAsync(uri, this._requestContextOf(req));
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

        const grammar = this._scopeOf(req).grammar;
        let patched = grammar ? this._applyGrammar(tools, grammar) : tools;
        const presenting = [...this._extensions.values()].filter((extension) => extension.presentTools && extension.settings() !== undefined);
        if (presenting.length > 0) {
            const context = this._requestContextOf(req);
            for (const extension of presenting) patched = extension.presentTools!(patched, context);
        }

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

    /**
     * Handles `resources/subscribe`.
     *
     * The URI must resolve to something this server can read (a listed
     * resource, a template match, or the session's phrases), otherwise the
     * answer is `-32002`: accepting a subscription nothing will ever notify
     * would leave the client waiting on a URI that does not exist.
     * Subscribing twice is not an error; the set simply keeps one entry.
     */
    resourcesSubscribe(req: JsonRpcRequest): JsonRpcResponse {
        const uri = (req.params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri !== "string" || uri.length === 0) return Mcp.invalidParams(req.id, "Missing required parameter: uri");
        if (!this._isReadable(uri)) return Mcp.resourceNotFound(req.id, uri);
        this._subscriptions.add(uri);
        return Mcp.emptyResult(req.id);
    }

    /**
     * Handles `resources/unsubscribe`. Idempotent: unsubscribing from a URI
     * that was never subscribed, or no longer exists, succeeds, because the
     * state the client asked for (not subscribed) is the state it gets.
     */
    resourcesUnsubscribe(req: JsonRpcRequest): JsonRpcResponse {
        const uri = (req.params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri !== "string" || uri.length === 0) return Mcp.invalidParams(req.id, "Missing required parameter: uri");
        this._subscriptions.delete(uri);
        return Mcp.emptyResult(req.id);
    }

    /** Handles `prompts/list`: the union of every behavior's prompts. */
    promptsList(req: JsonRpcRequest): JsonRpcResponse {
        const prompts: McpPrompt[] = [];
        for (const behavior of this._behaviors.values()) {
            prompts.push(...(behavior.getPrompts?.() ?? []));
        }
        return Mcp.promptsListResult(req.id, prompts);
    }

    /**
     * Handles `prompts/get`.
     *
     * An unknown name and a missing required argument are both `-32602`, the
     * code the spec gives for them. Argument values must be strings; anything
     * else is refused rather than coerced, since a template that receives
     * `[object Object]` produces a plausible but wrong message.
     */
    async promptsGetAsync(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { name?: unknown; arguments?: unknown } | undefined;
        const name = params?.name;
        if (typeof name !== "string" || name.length === 0) return Mcp.invalidParams(req.id, "Missing required parameter: name");

        const rawArgs = params?.arguments ?? {};
        if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) return Mcp.invalidParams(req.id, "arguments must be an object of strings");
        const args: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawArgs)) {
            if (typeof value !== "string") return Mcp.invalidParams(req.id, `Argument "${key}" must be a string`);
            args[key] = value;
        }

        const owner = this._promptOwner(name);
        if (!owner) return Mcp.invalidParams(req.id, `Unknown prompt: ${name}`);
        const missing = (owner.prompt.arguments ?? []).filter((a) => a.required && args[a.name] === undefined).map((a) => a.name);
        if (missing.length > 0) return Mcp.invalidParams(req.id, `Missing required argument(s) for prompt "${name}": ${missing.join(", ")}`);

        try {
            const result = await owner.behavior.getPromptAsync?.(name, args, this._requestContextOf(req));
            if (!result) return Mcp.invalidParams(req.id, `Unknown prompt: ${name}`);
            return Mcp.promptsGetResult(req.id, result);
        } catch (err) {
            return Mcp.internalError(req.id, `prompts/get "${name}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Handles `completion/complete`.
     *
     * The reference is routed to the behavior that owns it: the one listing
     * the prompt, or the one declaring the resource template. A reference no
     * behavior owns is `-32602`; an owner with nothing to suggest answers an
     * empty list, which is a valid answer and not an error.
     */
    async completionCompleteAsync(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const params = req.params as { ref?: unknown; argument?: unknown; context?: { arguments?: Record<string, string> } } | undefined;
        const ref = params?.ref as McpCompletionReference | undefined;
        const argument = params?.argument as McpCompletionArgument | undefined;
        if (!argument || typeof argument.name !== "string" || typeof argument.value !== "string") {
            return Mcp.invalidParams(req.id, "argument must be { name: string, value: string }");
        }

        let owner: IMcpBehavior | undefined;
        let label: string;
        if (ref?.type === "ref/prompt" && typeof ref.name === "string") {
            owner = this._promptOwner(ref.name)?.behavior;
            label = `prompt "${ref.name}"`;
        } else if (ref?.type === "ref/resource" && typeof ref.uri === "string") {
            const uriTemplate = ref.uri;
            owner = [...this._behaviors.values()].find((b) => b.getResourceTemplates().some((t) => t.uriTemplate === uriTemplate));
            label = `resource template "${uriTemplate}"`;
        } else {
            return Mcp.invalidParams(req.id, 'ref must be { type: "ref/prompt", name } or { type: "ref/resource", uri }');
        }
        if (!owner) return Mcp.invalidParams(req.id, `Nothing to complete for ${label}`);

        let completion: McpCompletion | undefined;
        try {
            completion = await owner.completeAsync?.(ref, argument, params?.context, this._requestContextOf(req));
        } catch (err) {
            return Mcp.internalError(req.id, `completion/complete: ${err instanceof Error ? err.message : String(err)}`);
        }
        const values = completion?.values ?? [];
        if (values.length <= MAX_COMPLETION_VALUES) return Mcp.completionResult(req.id, { ...completion, values });
        return Mcp.completionResult(req.id, { values: values.slice(0, MAX_COMPLETION_VALUES), total: completion?.total ?? values.length, hasMore: true });
    }

    /**
     * Handles `logging/setLevel`. Dispatched only when logging is enabled
     * ({@link IMcpServerOptions.logging}); an unknown level is `-32602`.
     */
    loggingSetLevel(req: JsonRpcRequest): JsonRpcResponse {
        const level = (req.params as { level?: unknown } | undefined)?.level;
        if (!isLoggingLevel(level)) return Mcp.invalidParams(req.id, `level must be one of: ${MCP_LOGGING_LEVELS.join(", ")}`);
        this._logLevel = level;
        return Mcp.emptyResult(req.id);
    }

    // -------------------------------------------------------------------------
    // Server-initiated notifications
    // -------------------------------------------------------------------------

    /** `true` when the current session subscribed to exactly `uri`. */
    isSubscribed(uri: string): boolean {
        return this._subscriptions.has(uri);
    }

    /**
     * Sends `notifications/resources/updated` for `uri` when, and only when,
     * this session subscribed to it. Returns whether a notification went out.
     */
    notifyResourceUpdated(uri: string): boolean {
        let sent = false;
        if (this._subscriptions.has(uri) && this._transport?.isOpen) {
            this._sendNotification(Mcp.resourceUpdated(uri));
            sent = true;
        }
        // Stateless subscribers: an update may name a sub-resource of the URI subscribed.
        for (const listen of this._listens.values()) {
            const watched = listen.filter.resourceSubscriptions ?? [];
            if (!watched.some((s) => s === uri || uri.startsWith(s.endsWith("/") ? s : `${s}/`))) continue;
            this._sendNotification({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri, _meta: { [MCP_META.subscriptionId]: listen.id } } });
            sent = true;
        }
        return sent;
    }

    /** Sends `notifications/resources/list_changed` to an initialized session. */
    notifyResourcesListChanged(): void {
        this._notifyResourcesListChanged();
    }

    /** Sends `notifications/prompts/list_changed` to an initialized session. */
    notifyPromptsListChanged(): void {
        this._notifyListens("notifications/prompts/list_changed", "promptsListChanged");
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.promptsListChanged());
    }

    /** Sends `notifications/tools/list_changed` to an initialized session. */
    notifyToolsListChanged(): void {
        this._notifyToolsListChanged();
    }

    /**
     * Emits one `notifications/message`. Silent, and returns `false`, when
     * logging is not enabled, when `level` is below the level the client set,
     * or when nothing is connected.
     */
    log(level: McpLoggingLevel, data: unknown, logger?: string): boolean {
        // A session only: a stateless client asks for messages per request
        // (`io.modelcontextprotocol/logLevel`, see `IMcpRequestContext.log`)
        // and must receive none it did not ask for.
        if (!this._options.logging || !this._transport?.isOpen || this._protocolVersion === undefined) return false;
        if (MCP_LOGGING_LEVELS.indexOf(level) < MCP_LOGGING_LEVELS.indexOf(this._logLevel)) return false;
        this._sendNotification(Mcp.logMessage(level, data, logger));
        return true;
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
     * Recursively patches property descriptions in a JSON schema object,
     * through nested objects and through the `items` of arrays of objects.
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

            // Recurse into the items of an array of objects: `crew.count`
            // addresses `crew.items.properties.count`, so a grammar names a
            // field the same way whether its parent is an object or a list.
            if (prop.items?.properties) {
                const items = this._patchProperties(toolName, prop.items, grammar, qualifiedKey);
                if (items !== prop.items) {
                    prop = { ...prop, items };
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
                // Before open, the error is the start() promise's business.
                if (!this._isRunning) {
                    reject(new Error(`McpServer: transport failed to open, ${error.message}`));
                    return;
                }
                // After open, start() is already settled and onClose only fires
                // when the medium actually closes, which a refusal or a protocol
                // fault need not do. Without this branch such errors vanished
                // entirely and the caller kept a resolved start() next to a
                // server no peer was serving.
                this._reportTransportError(error);
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
     *
     * Observers are told through {@link onDisconnected} once the state is clean,
     * so a handler that reads {@link isRunning} sees `false`.
     */
    private _onDisconnect(): void {
        this._isRunning = false;
        this._transport = null;
        this._sessionReady = false; // handshake must be repeated on reconnection
        this._protocolVersion = undefined; // revision must be renegotiated on reconnection
        this._sessionGrammar = undefined; // grammar must be re-resolved on reconnection
        this._currentGrammarKey = undefined;
        this._subscriptions.clear(); // subscriptions belong to the session, not the server
        this._clientCapabilities = undefined; // declared again at the next initialize
        this._clientInfo = undefined;
        // Work still running belongs to a session that is gone: stop it.
        for (const controller of this._inflight.values()) controller.abort(Object.assign(new Error("Session closed"), { name: "AbortError" }));
        this._inflight.clear();
        this._logLevel = DEFAULT_LOGGING_LEVEL;
        this._clearIdleTimer();
        this._onDisconnected?.emit();
    }

    /**
     * Publishes a post-open transport error.
     *
     * Falls back to `console.error` when nothing is subscribed, on purpose:
     * silence is the defect this exists to fix, and a caller who has not wired
     * {@link onTransportError} yet still needs the failure to reach a log. The
     * message names the subscription point so the fallback tells the reader how
     * to take over.
     */
    private _reportTransportError(error: Error): void {
        if (this._onTransportError && this._onTransportError.size > 0) {
            this._onTransportError.emit(error);
            return;
        }
        // eslint-disable-next-line no-console
        console.error(`[mcp-core] McpServer "${this._name}": transport error after open, ${error.message}. Subscribe to server.onTransportError to handle it yourself.`);
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

        const req = msg as JsonRpcRequest;
        if (req.method === "initialize") {
            this._send(await this._dispatch(req));
            return;
        }

        // A request carrying its own revision in `_meta` is stateless
        // (2026-07-28 and later); anything else belongs to the session.
        const stateless = this._statelessScopeFor(req);
        if (stateless && "jsonrpc" in stateless) {
            this._send(stateless);
            return;
        }
        if (stateless) this._statelessScopes.set(req, stateless);

        const key = inflightKey(req.id);
        const controller = new AbortController();
        this._inflight.set(key, controller);
        let response: JsonRpcResponse | undefined;
        try {
            response = stateless ? await this._dispatchStateless(req) : await this._dispatch(req);
        } finally {
            if (this._inflight.get(key) === controller) this._inflight.delete(key);
        }
        // A cancelled request gets no answer: the peer has already forgotten it.
        // `undefined`: the request was already answered (a listen the server closed).
        if (controller.signal.aborted || response === undefined) return;
        this._send(stateless ? this._decorateStateless(req, response) : this._guardSession(response));
    }

    /**
     * Handles `notifications/cancelled`: aborts the request's signal, so an
     * operation that listens can stop, and drops its answer. An unknown or
     * finished id is ignored, as the spec allows: the notification may simply
     * have crossed the answer.
     */
    private _cancelRequest(params: unknown): void {
        const { requestId, reason } = (params ?? {}) as { requestId?: unknown; reason?: unknown };
        if (typeof requestId !== "string" && typeof requestId !== "number") return;
        const controller = this._inflight.get(inflightKey(requestId));
        if (!controller) return;
        this._inflight.delete(inflightKey(requestId));
        const error = new Error(typeof reason === "string" && reason ? reason : "Request cancelled by the client");
        error.name = "AbortError";
        controller.abort(error);
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
            case "notifications/cancelled":
                this._cancelRequest(notification.params);
                break;
            default: {
                // An extension's notification, while that extension is declared.
                // All others are ignored, as the protocol requires.
                const entry = this._extensionNotifications.get(notification.method);
                if (!entry || entry.extension.settings() === undefined) break;
                try {
                    entry.handler(notification.params);
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.error(`[mcp-core] extension "${entry.extension.id}" failed on ${notification.method}: ${(error as Error).message}`);
                }
            }
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
            // The handlers below were added after `IMcpServerHandlers` was
            // published, so a custom handler may lack them: this server's own
            // implementation answers instead of a `-32601`.
            case "resources/subscribe":
                return this._handlers.resourcesSubscribe ? this._handlers.resourcesSubscribe(req) : this.resourcesSubscribe(req);
            case "resources/unsubscribe":
                return this._handlers.resourcesUnsubscribe ? this._handlers.resourcesUnsubscribe(req) : this.resourcesUnsubscribe(req);
            case "prompts/list":
                return this._handlers.promptsList ? this._handlers.promptsList(req) : this.promptsList(req);
            case "prompts/get":
                return this._handlers.promptsGetAsync ? this._handlers.promptsGetAsync(req) : this.promptsGetAsync(req);
            case "completion/complete":
                return this._handlers.completionCompleteAsync ? this._handlers.completionCompleteAsync(req) : this.completionCompleteAsync(req);
            case "logging/setLevel":
                // A method the server does not advertise is one it does not have.
                if (!this._options.logging) return Mcp.methodNotFound(req.id, req.method);
                return this._handlers.loggingSetLevel ? this._handlers.loggingSetLevel(req) : this.loggingSetLevel(req);
            default:
                return this._dispatchExtension(req);
        }
    }

    /**
     * Routes a request to the extension that added its method, while that
     * extension is declared. A throwing handler is answered `-32603`: a fault
     * in an extension must not leave the request unanswered.
     */
    private async _dispatchExtension(req: JsonRpcRequest): Promise<JsonRpcResponse> {
        const entry = this._extensionMethods.get(req.method);
        if (!entry || entry.extension.settings() === undefined) return Mcp.methodNotFound(req.id, req.method);
        if (entry.extension.statelessOnly && !this._scopeOf(req).stateless) return Mcp.methodNotFound(req.id, req.method);
        try {
            return await entry.handler(req, this._requestContextOf(req));
        } catch (error) {
            return Mcp.internalError(req.id, error instanceof Error ? error.message : String(error));
        }
    }

    /** The view of this server extensions receive. One per server. */
    private _hostForExtensions(): IMcpExtensionHost {
        if (this._extensionHost) return this._extensionHost;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const server = this;
        this._extensionHost = {
            get clientCapabilities() {
                return server._clientCapabilities;
            },
            get clientInfo() {
                return server._clientInfo;
            },
            get protocolVersion() {
                return server._protocolVersion;
            },
            get isSessionReady() {
                return server._sessionReady;
            },
            get onDisconnected() {
                return server.onDisconnected;
            },
            clientExtension: (extensionId) => server.clientExtension(extensionId),
            notify: (method, params) => {
                if (!server._sessionReady || !server._transport?.isOpen) return false;
                server._sendNotification({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
                return true;
            },
            notifyToolsListChanged: () => server.notifyToolsListChanged(),
            notifyResourcesListChanged: () => server.notifyResourcesListChanged(),
            notifyResourceUpdated: (uri) => server.notifyResourceUpdated(uri),
            notifyListeners: (flag, method, params) => server._notifyListens(method, flag, params),
        };
        return this._extensionHost;
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
        this._notifyListens("notifications/resources/list_changed", "resourcesListChanged");
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.resourcesListChanged());
    }

    /**
     * Sends a `notifications/tools/list_changed` notification to the client.
     * Only fires when the session is fully initialized and the WebSocket is open.
     */
    private _notifyToolsListChanged(): void {
        this._notifyListens("notifications/tools/list_changed", "toolsListChanged");
        this._notifySessionToolsListChanged();
    }

    /** `notifications/tools/list_changed` to the `initialize` session only. */
    private _notifySessionToolsListChanged(): void {
        if (!this._sessionReady) return;
        this._sendNotification(Mcp.toolsListChanged());
    }

    /** Sends one list-changed notification to every open listen that asked for it, tagged with its id. */
    private _notifyListens(method: string, flag: string, params: Record<string, unknown> = {}): number {
        let sent = 0;
        for (const listen of this._listens.values()) {
            if (listen.filter[flag] !== true) continue;
            this._sendNotification({ jsonrpc: "2.0", method, params: { ...params, _meta: { [MCP_META.subscriptionId]: listen.id } } });
            sent++;
        }
        return sent;
    }

    /**
     * Reacts to a grammar store mutation. If the changed profile is the one
     * currently active for this session, re-merges the session grammar
     * from all four layers and notifies the client so it can re-fetch
     * `tools/list`.
     */
    private _onGrammarStoreChanged(event: McpGrammarStoreChangeEvent): void {
        // Stateless clients may use any key: forget every composed grammar.
        this._grammarCache.clear();
        this._notifyListens("notifications/tools/list_changed", "toolsListChanged");
        if (!this._currentGrammarKey || event.profileId !== this._currentGrammarKey) return;
        this._sessionGrammar = this._composeSessionGrammar(this._currentGrammarKey);
        this._notifySessionToolsListChanged();
    }

    /**
     * Reacts to a behavior advertising that its grammar map changed
     * (hot-reload, runtime mutation). Re-merges the session grammar for
     * the currently active key and notifies the client. No-op when no
     * session is active or the active key cannot be re-merged.
     */
    private _onBehaviorGrammarsChanged(): void {
        this._grammarCache.clear();
        this._notifyListens("notifications/tools/list_changed", "toolsListChanged");
        if (!this._currentGrammarKey) return;
        this._sessionGrammar = this._composeSessionGrammar(this._currentGrammarKey);
        this._notifySessionToolsListChanged();
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
    private _deriveCapabilities(stateless = false): McpServerCapabilities {
        let hasResources = false;
        let hasTools = false;
        let hasPrompts = false;
        let hasCompletions = false;

        for (const behavior of this._behaviors.values()) {
            if (!hasResources && (behavior.getResources().length > 0 || behavior.getResourceTemplates().length > 0)) hasResources = true;
            if (!hasTools && (behavior.dynamicTools === true || behavior.getTools().length > 0)) hasTools = true;
            if (!hasPrompts && (behavior.getPrompts?.().length ?? 0) > 0) hasPrompts = true;
            if (!hasCompletions && typeof behavior.completeAsync === "function") hasCompletions = true;
        }

        const capabilities: McpServerCapabilities = {};
        // `subscribe` holds whenever resources exist: the server keeps the
        // per-session subscription set itself, whether or not a behavior ever
        // raises `onResourceUpdated`.
        if (hasResources) capabilities.resources = { subscribe: true, listChanged: true };
        if (hasTools) capabilities.tools = { listChanged: true };
        if (hasPrompts) capabilities.prompts = { listChanged: true };
        if (hasCompletions) capabilities.completions = {};
        if (this._options.logging) capabilities.logging = {};
        for (const extension of this._extensions.values()) {
            const settings = extension.settings();
            if (settings === undefined || (extension.statelessOnly && !stateless)) continue;
            capabilities.extensions = { ...(capabilities.extensions ?? {}), [extension.id]: { ...settings } };
        }
        return capabilities;
    }

    /** `true` when `resources/read` could resolve `uri` right now. */
    private _isReadable(uri: string, grammar: McpGrammar | undefined = this._sessionGrammar): boolean {
        if (uri === GRAMMAR_PHRASES_URI) return grammar?.hasPhrases() ?? false;
        return this._resourceIndex.has(uri) || this._matchTemplate(uri) !== undefined;
    }

    /** The behavior that lists prompt `name`, with the prompt itself. */
    private _promptOwner(name: string): { behavior: IMcpBehavior; prompt: McpPrompt } | undefined {
        for (const behavior of this._behaviors.values()) {
            const prompt = behavior.getPrompts?.().find((p) => p.name === name);
            if (prompt) return { behavior, prompt };
        }
        return undefined;
    }

    /** Rebuilds the exact-URI index after a behavior's resource set changed. */
    private _reindexResources(): void {
        this._resourceIndex.clear();
        for (const behavior of this._behaviors.values()) {
            for (const r of behavior.getResources()) this._resourceIndex.set(r.uri, behavior);
        }
    }

    /** Wires one behavior's change events to the notifications they stand for. */
    private _subscribeBehaviorEvents(b: IMcpBehavior): void {
        const unsubs: Unsubscribe[] = [];
        if (b.onResourceUpdated) unsubs.push(b.onResourceUpdated.subscribe((uri) => void this.notifyResourceUpdated(uri)));
        if (b.onResourcesListChanged) {
            unsubs.push(
                b.onResourcesListChanged.subscribe(() => {
                    this._reindexResources();
                    this._notifyResourcesListChanged();
                })
            );
        }
        if (b.onPromptsChanged) unsubs.push(b.onPromptsChanged.subscribe(() => this.notifyPromptsListChanged()));
        if (b.onToolsListChanged) unsubs.push(b.onToolsListChanged.subscribe(() => this._notifyToolsListChanged()));
        if (unsubs.length > 0) this._behaviorEventUnsubs.set(b.namespace, unsubs);
    }

    private _releaseBehaviorEvents(namespace: string): void {
        for (const unsub of this._behaviorEventUnsubs.get(namespace) ?? []) unsub();
        this._behaviorEventUnsubs.delete(namespace);
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

    /** Builds a request context with a server-local sequence that never uses zero or repeats. */
    private _requestContextOf(req: JsonRpcRequest): IMcpRequestContext {
        if (this._requestSequence >= Number.MAX_SAFE_INTEGER) throw new Error("MCP request sequence exhausted");
        this._requestSequence += 1;
        const scope = this._scopeOf(req);
        const params = isPlainObject(req.params) ? req.params : {};
        const extra: Partial<IMcpRequestContext> = {
            stateless: scope.stateless,
            ...(scope.protocolVersion !== undefined ? { protocolVersion: scope.protocolVersion } : {}),
            ...(scope.clientCapabilities !== undefined ? { clientCapabilities: scope.clientCapabilities } : {}),
            ...(scope.clientInfo !== undefined ? { clientInfo: scope.clientInfo } : {}),
            ...(scope.stateless && isPlainObject(params["inputResponses"]) ? { inputResponses: Object.freeze({ ...params["inputResponses"] }) } : {}),
            ...(scope.stateless && typeof params["requestState"] === "string" ? { requestState: params["requestState"] } : {}),
            log: (level: McpLoggingLevel, data: unknown, logger?: string) => this._logFor(req, scope, level, data, logger),
            notify: (method: string, params?: Record<string, unknown>) => {
                // Only while the request is in flight: once answered or cancelled, it may say nothing more.
                if (!this._inflight.has(inflightKey(req.id)) || !this._transport?.isOpen) return false;
                this._sendNotification({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
                return true;
            },
        };
        return requestContextOf(req, this._requestSequence, this._inflight.get(inflightKey(req.id))?.signal, extra);
    }

    // -------------------------------------------------------------------------
    // Stateless revisions (2026-07-28 and later)
    // -------------------------------------------------------------------------

    /** The scope a handler serves `req` under: its own when stateless, the session's otherwise. */
    private _scopeOf(req: JsonRpcRequest): IRequestScope {
        return (
            this._statelessScopes.get(req) ?? {
                stateless: false,
                protocolVersion: this._protocolVersion,
                clientCapabilities: this._clientCapabilities,
                clientInfo: this._clientInfo,
                grammar: this._sessionGrammar,
                grammarKey: this._currentGrammarKey,
            }
        );
    }

    /**
     * Picks the wording for a client: the first candidate key the resolver
     * returns that composes to a grammar.
     */
    private _resolveGrammar(
        clientInfo: McpClientInfo,
        capabilities: McpClientCapabilities | undefined,
        compose: (key: string) => McpGrammar | undefined
    ): { key: string | undefined; grammar: McpGrammar | undefined } {
        const raw = this._grammarResolver?.(clientInfo, capabilities);
        const candidates: readonly string[] = !raw ? [] : typeof raw === "string" ? [raw] : raw;
        for (const candidate of candidates) {
            const merged = compose(candidate);
            if (merged) return { key: candidate, grammar: merged };
        }
        return { key: undefined, grammar: undefined };
    }

    /** {@link _composeSessionGrammar}, cached for stateless requests until a grammar changes. */
    private _composeCachedGrammar(key: string): McpGrammar | undefined {
        if (!this._grammarCache.has(key)) this._grammarCache.set(key, this._composeSessionGrammar(key) ?? null);
        return this._grammarCache.get(key) ?? undefined;
    }

    /**
     * Reads a request's stateless `_meta`.
     *
     * @returns `undefined` for a request written for a handshake revision
     * (no `io.modelcontextprotocol/protocolVersion`, or stateless serving
     * turned off), the request's scope, or the error to answer with.
     */
    private _statelessScopeFor(req: JsonRpcRequest): IRequestScope | JsonRpcResponse | undefined {
        const versions = this._options.statelessProtocolVersions ?? MCP_STATELESS_PROTOCOL_VERSIONS;
        if (versions.length === 0) return undefined;
        const meta = isPlainObject(req.params) ? req.params["_meta"] : undefined;
        if (!isPlainObject(meta) || !(MCP_META.protocolVersion in meta)) return undefined;

        const requested = meta[MCP_META.protocolVersion];
        if (typeof requested !== "string" || !versions.includes(requested)) {
            return jsonRpcError(req.id, MCP_ERROR_CODES.unsupportedProtocolVersion, `Unsupported protocol version: ${String(requested)}`, {
                supported: [...versions],
                requested: String(requested),
            });
        }
        const capabilities = meta[MCP_META.clientCapabilities];
        if (!isPlainObject(capabilities)) return Mcp.invalidParams(req.id, `Missing required params._meta["${MCP_META.clientCapabilities}"]`);
        const info = meta[MCP_META.clientInfo];
        const clientInfo = isPlainObject(info) && typeof info["name"] === "string" && typeof info["version"] === "string" ? (info as unknown as McpClientInfo) : undefined;
        const level = meta[MCP_META.logLevel];
        if (level !== undefined && !isLoggingLevel(level)) return Mcp.invalidParams(req.id, `Invalid params._meta["${MCP_META.logLevel}"]: ${String(level)}`);

        const identifiedAs = clientInfo ?? { name: "unknown", version: "0.0.0" };
        const { key, grammar } = this._resolveGrammar(identifiedAs, capabilities as McpClientCapabilities, (k) => this._composeCachedGrammar(k));
        const identity = this._initializer
            ? this._initializer.initialize(identifiedAs, capabilities as McpClientCapabilities)
            : { serverInfo: { name: this._name, version: "0.0.0" } };
        const serverInfo =
            grammar?.getServerDescription() && !identity.serverInfo.description ? { ...identity.serverInfo, description: grammar.getServerDescription() } : identity.serverInfo;
        const instructions = identity.instructions ?? grammar?.getServerInstructions();
        return {
            stateless: true,
            protocolVersion: requested,
            clientCapabilities: capabilities as McpClientCapabilities,
            clientInfo,
            grammar,
            grammarKey: key,
            ...(level !== undefined ? { logLevel: level as McpLoggingLevel } : {}),
            serverInfo,
            ...(instructions !== undefined ? { instructions } : {}),
        };
    }

    /** Routes a stateless request: the methods it adds, the ones it removed, then the shared handlers. */
    private async _dispatchStateless(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
        if (MCP_STATELESS_REMOVED_METHODS.includes(req.method)) return Mcp.methodNotFound(req.id, req.method);
        switch (req.method) {
            case "server/discover":
                return this._discover(req);
            case "subscriptions/listen":
                return this._listen(req);
            default:
                return this._dispatch(req);
        }
    }

    /** `server/discover`: the revisions, capabilities and instructions of this server. */
    private _discover(req: JsonRpcRequest): JsonRpcResponse {
        const scope = this._scopeOf(req);
        return jsonRpcOk(req.id, {
            supportedVersions: [...(this._options.statelessProtocolVersions ?? MCP_STATELESS_PROTOCOL_VERSIONS)],
            capabilities: this._deriveCapabilities(true),
            ...(scope.instructions !== undefined ? { instructions: scope.instructions } : {}),
        });
    }

    /**
     * `subscriptions/listen`: acknowledges the subset of notifications this
     * server can honor, then stays pending, delivering each matching change
     * tagged with the request id, until the client cancels it or the server
     * stops (which answers it).
     */
    private _listen(req: JsonRpcRequest): JsonRpcResponse | Promise<JsonRpcResponse | undefined> {
        const asked = isPlainObject(req.params) ? req.params["notifications"] : undefined;
        if (!isPlainObject(asked)) return Mcp.invalidParams(req.id, "subscriptions/listen needs params.notifications");
        const capabilities = this._deriveCapabilities(true);
        const honored: ISubscriptionFilter = {};
        // Flags an extension adds, honored while it is declared.
        for (const extension of this._extensions.values()) {
            if (extension.settings() === undefined) continue;
            for (const flag of extension.subscriptionFlags ?? []) if (asked[flag] === true) honored[flag] = true;
        }
        if (asked["toolsListChanged"] === true && capabilities.tools) honored.toolsListChanged = true;
        if (asked["promptsListChanged"] === true && capabilities.prompts) honored.promptsListChanged = true;
        if (asked["resourcesListChanged"] === true && capabilities.resources) honored.resourcesListChanged = true;
        const uris = asked["resourceSubscriptions"];
        if (Array.isArray(uris) && capabilities.resources) {
            const grammar = this._scopeOf(req).grammar;
            honored.resourceSubscriptions = [...new Set(uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0 && this._isReadable(uri, grammar)))];
        }

        // The acknowledgement is the first message of the subscription.
        this._sendNotification({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: { notifications: honored, _meta: { [MCP_META.subscriptionId]: req.id } },
        });

        const key = inflightKey(req.id);
        const signal = this._inflight.get(key)?.signal;
        return new Promise<JsonRpcResponse | undefined>((resolve) => {
            const listen: IListen = {
                id: req.id,
                filter: honored,
                finish: () => {
                    if (this._listens.get(key) === listen) this._listens.delete(key);
                    resolve(undefined);
                },
            };
            this._listens.set(key, listen);
            signal?.addEventListener("abort", () => listen.finish(), { once: true });
        });
    }

    /**
     * Completes a stateless response: `resultType`, the server's identity,
     * caching hints on cacheable results, and the 2026-07-28 error codes.
     */
    private _decorateStateless(req: JsonRpcRequest, response: JsonRpcResponse): JsonRpcResponse {
        if (response.error) {
            // Resource not found is -32602 since 2026-07-28; -32002 is retired.
            if (response.error.code !== -32002) return response;
            const uri = isPlainObject(req.params) ? req.params["uri"] : undefined;
            return { ...response, error: { code: -32602, message: response.error.message, data: { uri } } };
        }
        const result: Record<string, unknown> = isPlainObject(response.result) ? { ...response.result } : {};
        if (result["resultType"] === undefined) result["resultType"] = "complete";
        const serverInfo = this._scopeOf(req).serverInfo;
        if (serverInfo) result["_meta"] = { ...(isPlainObject(result["_meta"]) ? result["_meta"] : {}), [MCP_META.serverInfo]: serverInfo };
        if (MCP_CACHEABLE_METHODS.includes(req.method) && result["resultType"] === "complete") {
            const cache = this._options.cache ?? { ttlMs: 0, cacheScope: "private" };
            if (result["ttlMs"] === undefined) result["ttlMs"] = cache.ttlMs;
            if (result["cacheScope"] === undefined) result["cacheScope"] = cache.cacheScope;
        }
        return { ...response, result };
    }

    /**
     * A handshake client cannot take a multi round-trip answer: a behavior
     * asking for input is reported as an error instead.
     */
    private _guardSession(response: JsonRpcResponse): JsonRpcResponse {
        if (isPlainObject(response.result) && response.result["resultType"] === "input_required") {
            return jsonRpcError(response.id, -32603, "This request needs more input from the client, which requires protocol revision 2026-07-28 or later");
        }
        return response;
    }

    /** `notifications/message` for one request: stateless per its `logLevel`, session as {@link log}. */
    private _logFor(req: JsonRpcRequest, scope: IRequestScope, level: McpLoggingLevel, data: unknown, logger?: string): boolean {
        if (!scope.stateless) return this.log(level, data, logger);
        if (!this._options.logging || scope.logLevel === undefined || !this._transport?.isOpen) return false;
        if (!this._inflight.has(inflightKey(req.id))) return false;
        if (MCP_LOGGING_LEVELS.indexOf(level) < MCP_LOGGING_LEVELS.indexOf(scope.logLevel)) return false;
        this._sendNotification(Mcp.logMessage(level, data, logger));
        return true;
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
            const result = await instance.executeToolAsync(uri, name, args, this._requestContextOf(req));
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
