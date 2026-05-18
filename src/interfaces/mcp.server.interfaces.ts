import type { IMcpServerHandlers, McpClientCapabilities, McpClientInfo, McpServerIdentity } from "./mcp.core.interfaces";
import type { IMcpBehavior } from "./mcp.behavior.interfaces";
import type { IMessageTransport } from "./mcp.transport.interfaces";
import type { McpGrammar } from "../mcp.grammar";
import type { McpGrammarStore } from "../mcp.grammarStore";

/**
 * Maps {@link McpClientInfo} to a grammar key from the server's grammar map.
 * Return `undefined` to skip grammar patching for the connecting client.
 *
 * @example
 * ```typescript
 * const resolver: McpGrammarResolver = (client) => {
 *     if (client.name.includes("claude")) return "concise";
 *     if (client.name.includes("gpt"))    return "verbose";
 *     return undefined; // fallback descriptions only
 * };
 * ```
 */
export type McpGrammarResolver = (clientInfo: McpClientInfo) => string | undefined;

/**
 * Handles the domain-level MCP initialization handshake.
 *
 * Responsible for protocol version negotiation and server identity.
 * Capabilities are intentionally excluded — the server derives them
 * automatically from all registered {@link IMcpBehavior}s at handshake time.
 *
 * @example
 * ```typescript
 * class MyInitializer implements IMcpInitializer {
 *     initialize(_clientInfo: McpClientInfo, _caps: McpClientCapabilities): McpServerIdentity {
 *         return {
 *             protocolVersion: "2024-11-05",
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
     * Sets the function that maps a connecting client to a grammar key.
     * Called during the `initialize` handshake with the client's identity.
     * The returned key is looked up in the grammars registered via {@link withGrammar}.
     */
    withGrammarResolver(resolver: McpGrammarResolver): IMcpServerBuilder;

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
