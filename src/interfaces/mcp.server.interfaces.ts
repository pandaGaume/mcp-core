import type { IMcpServerHandlers, McpClientCapabilities, McpClientInfo, McpServerIdentity } from "./mcp.core.interfaces";
import type { IMcpBehavior } from "./mcp.behavior.interfaces";
import type { IMessageTransport } from "./mcp.transport.interfaces";
import type { McpGrammar } from "../mcp.grammar";
import type { McpGrammarStore } from "../mcp.grammarStore";
import type { GrammarResolverOptions } from "../mcp.resolver";

/**
 * Maps a connecting {@link McpClientInfo} (plus optionally its negotiated
 * capabilities) to a grammar key, or an ordered chain of candidate keys
 * the server will try in turn until one yields a non-empty merged layer.
 *
 * - Returning `string` selects a single key. The server tries it and falls
 *   back to inline tool descriptions if no layer matches.
 * - Returning `readonly string[]` describes a most-specific-first fallback
 *   chain. The server picks the first key for which at least one of the
 *   four layers (behavior / adapter / static / store) registered a grammar.
 * - Returning `undefined` skips grammar patching entirely.
 *
 * The second `capabilities` parameter exposes what the client declared
 * during the `initialize` handshake. Use it for version-aware composition,
 * e.g. `(_, caps) => caps?.protocolVersion ?? "v1"`.
 *
 * @example single-key form (backwards compatible with 0.2.x)
 * ```typescript
 * const resolver: McpGrammarResolver = (client) => {
 *     if (client.name.includes("claude")) return "concise";
 *     return undefined;
 * };
 * ```
 *
 * @example chain form (new in 0.3.x)
 * ```typescript
 * const resolver: McpGrammarResolver = (client) => [
 *     "claude:fr-ca", "claude:fr", "default:fr-ca", "default:fr", "default:en",
 * ];
 * ```
 *
 * @see {@link grammarResolverFromOptions} for a helper that builds these
 *      chains from a declarative {@link GrammarResolverOptions}.
 */
export type McpGrammarResolver = (clientInfo: McpClientInfo, capabilities?: McpClientCapabilities) => string | readonly string[] | undefined;

/**
 * Handles the domain-level MCP initialization handshake.
 *
 * Responsible for server identity. Capabilities are intentionally excluded —
 * the server derives them automatically from all registered
 * {@link IMcpBehavior}s at handshake time. Protocol version negotiation is
 * likewise handled by the server; return
 * {@link McpServerIdentity.protocolVersion} only to pin a revision explicitly.
 *
 * @example
 * ```typescript
 * class MyInitializer implements IMcpInitializer {
 *     initialize(_clientInfo: McpClientInfo, _caps: McpClientCapabilities): McpServerIdentity {
 *         return {
 *             serverInfo: { name: "my-mcp-server", version: "1.0.0" },
 *             instructions: "Interact with the host application's active scene.",
 *         };
 *     }
 * }
 * ```
 */
export interface IMcpInitializer {
    /**
     * @param clientInfo - Identity of the connecting client.
     * @param clientCapabilities - Features the client declares it supports.
     * @returns Server identity and protocol version. Capabilities are auto-derived
     *          by the server and must not be included here.
     */
    initialize(clientInfo: McpClientInfo, clientCapabilities: McpClientCapabilities): McpServerIdentity;
}

/**
 * Configuration options for an {@link IMcpServer} instance.
 */
export interface IMcpServerOptions {
    /**
     * The MCP protocol revisions this server accepts during the `initialize`
     * handshake, ordered newest first.
     *
     * The server echoes the revision the client requested when it appears in
     * this list, and answers with the first entry otherwise. Narrow the list to
     * cap the revision a server will speak; omit it to accept everything the
     * package implements.
     *
     * @default MCP_SUPPORTED_PROTOCOL_VERSIONS
     */
    protocolVersions?: readonly string[];

    /**
     * Close the WebSocket connection after this many milliseconds of inactivity
     * (i.e. no message received). The timer resets on every incoming message.
     * Omit to disable idle detection.
     */
    idleTimeoutMs?: number;

    /** Automatic reconnection policy applied when the connection drops unexpectedly. */
    reconnect?: {
        /**
         * Initial delay in milliseconds before the first reconnection attempt.
         * Subsequent attempts use exponential back-off: `min(baseDelayMs * 2^n, maxDelayMs)`.
         * @default 1000
         */
        baseDelayMs?: number;

        /**
         * Upper bound on the reconnection delay in milliseconds.
         * @default 30000
         */
        maxDelayMs?: number;

        /**
         * Maximum number of reconnection attempts before giving up.
         * Omit for unlimited attempts.
         */
        maxAttempts?: number;
    };
}

/**
 * Fluent builder for constructing an {@link IMcpServer}.
 *
 * Call {@link withBehavior} once per behavior type you want to support.
 * After {@link build}, use {@link IMcpServer.attach} to register live object instances.
 *
 * @example
 * ```typescript
 * const server = builder
 *     .withName("my-app")
 *     .withWsUrl("ws://localhost:8080")
 *     .withInitializer(new SceneInitializer())
 *     .withBehavior(new MeshBehavior())
 *     .withBehavior(new LightBehavior())
 *     .withOptions({ idleTimeoutMs: 30_000 })
 *     .build();
 *
 * await server.start();
 * server.attach(heroMesh, meshBehavior);
 * server.attach(sunLight, lightBehavior);
 * ```
 */
export interface IMcpServerBuilder {
    withWsUrl(url: string): IMcpServerBuilder;
    withName(name: string): IMcpServerBuilder;
    withInitializer(initializer: IMcpInitializer): IMcpServerBuilder;
    register(...behavior: IMcpBehavior[]): IMcpServerBuilder;
    /**
     * Replaces the default JSON-RPC message routing with a custom implementation.
     * When omitted, {@link McpServer} handles routing itself.
     * Use this to intercept, override, or extend individual MCP method handlers.
     */
    withHandlers(handlers: IMcpServerHandlers): IMcpServerBuilder;
    withOptions(o: IMcpServerOptions): IMcpServerBuilder;

    /**
     * Registers a named grammar that can be selected per session.
     * Use {@link withGrammarResolver} to map connecting clients to grammar keys.
     */
    withGrammar(key: string, grammar: McpGrammar): IMcpServerBuilder;

    /**
     * Sets the policy that maps a connecting client to a grammar key.
     *
     * Two argument forms are accepted:
     *
     * - **Custom function**: pass an {@link McpGrammarResolver} when you need
     *   arbitrary logic. Called during the `initialize` handshake with the
     *   client's identity and negotiated capabilities. The returned key
     *   (or chain of candidate keys) is looked up across the four grammar
     *   layers (behavior / adapter / static / store).
     *
     * - **Options object**: pass a {@link GrammarResolverOptions} to use the
     *   built-in helper that composes locale / agent / version dimensions
     *   into a deterministic fallback chain. Equivalent to passing
     *   `grammarResolverFromOptions(options)`.
     *
     * @example custom function
     * ```typescript
     * builder.withGrammarResolver((client) => `${client.name}:en`);
     * ```
     *
     * @example declarative options
     * ```typescript
     * builder.withGrammarResolver({
     *     localeSource: (_, caps) => caps?.locale,
     *     versionFrom:  (_, caps) => caps?.protocolVersion,
     * });
     * ```
     */
    withGrammarResolver(resolver: McpGrammarResolver | GrammarResolverOptions): IMcpServerBuilder;

    /**
     * Provides a shared grammar store for runtime grammar mutations.
     * When set, store grammars are merged with static grammars (store wins).
     * The server subscribes to store changes and emits `notifications/tools/list_changed`.
     */
    withGrammarStore(store: McpGrammarStore): IMcpServerBuilder;

    /**
     * Provides an external transport (e.g. {@link MultiplexTransport}) instead
     * of the default {@link DirectTransport}. When set, `withWsUrl()` is optional.
     */
    withTransport(transport: IMessageTransport): IMcpServerBuilder;

    build(): IMcpServer;
}

/**
 * A running MCP server that acts as an aggregating proxy over registered behaviors.
 *
 * Resources and tools exposed to the client are the union of all
 * {@link IMcpBehaviorInstance}s currently attached to the server.
 * Behaviors and instances can be added or removed at any time, even while running.
 *
 * Obtained via {@link IMcpServerBuilder.build}.
 */
export interface IMcpServer {
    /** Human-readable name of this server instance. */
    readonly name: string;

    /** Whether the server is currently running and accepting connections. */
    readonly isRunning: boolean;

    /** Starts the server and begins accepting client connections. */
    start(): Promise<void>;

    /** Gracefully stops the server and closes all active connections. */
    stop(): Promise<void>;

    register(...behavior: IMcpBehavior[]): IMcpServer;

    unregister(...behavior: IMcpBehavior[]): IMcpServer;
}

/**
 * Lets any object embbed mcp servers.
 */
export interface IHasMcpServers {
    McpServer: IMcpServer[];
}

/**
 * type guard.
 * @param value teh object to test
 * @returns true if the object seems to implement the interface.
 */
export function isHasMcpServers(value: unknown): value is IHasMcpServers {
    return typeof value === "object" && value !== null && "McpServer" in value && Array.isArray((value as { McpServer: unknown }).McpServer);
}
