import type { JsonRpcRequest, JsonRpcResponse } from "./mcp.jsonrpc.interfaces";
import type { McpClientCapabilities, McpClientInfo, McpTool } from "./mcp.core.interfaces";
import type { IMcpBehavior, IMcpRequestContext } from "./mcp.behavior.interfaces";
import type { IEventSource } from "./eventSource";

/**
 * Answers one request method an extension adds. A handler that throws is
 * answered `-32603 Internal error` with its message; return a JSON-RPC error
 * (`Mcp.invalidParams`, ...) for anything the caller can fix.
 */
export type McpExtensionHandler = (req: JsonRpcRequest, ctx: IMcpRequestContext) => JsonRpcResponse | Promise<JsonRpcResponse>;

/** Receives one client-to-server notification an extension adds. */
export type McpExtensionNotificationHandler = (params: unknown) => void;

/**
 * What an extension may see and do on the server that hosts it. Handed over
 * once, through {@link IMcpServerExtension.attach}.
 */
export interface IMcpExtensionHost {
    /** The capabilities the client declared at `initialize`, `undefined` before it. */
    readonly clientCapabilities: McpClientCapabilities | undefined;
    /** The client's identity from `initialize`, `undefined` before it. */
    readonly clientInfo: McpClientInfo | undefined;
    /** The negotiated protocol revision, `undefined` before `initialize`. */
    readonly protocolVersion: string | undefined;
    /** `true` once the client sent `notifications/initialized`. */
    readonly isSessionReady: boolean;
    /** Fires when the transport closes: end long-lived work, drop session state. */
    readonly onDisconnected: IEventSource<void>;

    /**
     * Whether the client declared support for `extensionId` in its
     * `capabilities.extensions`, with its settings when it did.
     */
    clientExtension(extensionId: string): Readonly<Record<string, unknown>> | undefined;

    /**
     * Sends a server-to-client notification. Dropped (`false`) before
     * `notifications/initialized` or once the transport is closed.
     */
    notify(method: string, params?: unknown): boolean;

    /** Re-announces the server's tools, resources or prompts after the extension changed what they show. */
    notifyToolsListChanged(): void;
    notifyResourcesListChanged(): void;
    notifyResourceUpdated(uri: string): boolean;

    /**
     * Sends `method` to every open stateless `subscriptions/listen` that asked
     * for `flag` (one of the extension's {@link IMcpServerExtension.subscriptionFlags}),
     * tagged with the listen's id. Returns how many listens it reached.
     */
    notifyListeners(flag: string, method: string, params?: Record<string, unknown>): number;
}

/**
 * An MCP extension served by an {@link McpServer}: a capability declared
 * under `capabilities.extensions[id]`, the request methods and notifications
 * it adds, and the behaviors that serve its tools, resources or prompts.
 *
 * Methods are served only while the extension is declared, that is while
 * {@link settings} returns an object: a client that respects the declaration
 * and one that ignores it see the same server.
 *
 * Register with `McpServerBuilder.withExtension(ext)`.
 */
export interface IMcpServerExtension {
    /** The extension identifier, e.g. `"io.modelcontextprotocol/skills"`. */
    readonly id: string;

    /**
     * The settings object declared under `capabilities.extensions[id]`.
     * `{}` declares the extension with no optional feature; `undefined` does
     * not declare it (and its methods answer `-32601`).
     */
    settings(): Readonly<Record<string, unknown>> | undefined;

    /** Request methods the extension adds. A core method cannot be claimed. */
    readonly methods?: Readonly<Record<string, McpExtensionHandler>>;

    /** Client-to-server notifications the extension adds. */
    readonly notifications?: Readonly<Record<string, McpExtensionNotificationHandler>>;

    /**
     * Adjusts one `tools/list` answer, after the grammar is applied: an
     * extension may hide, add or rewrite tools according to what the client
     * declared for this request (`request.clientCapabilities`: the session's,
     * or the request's own when it is stateless). Called only while the
     * extension is declared, in registration order.
     */
    presentTools?(tools: readonly McpTool[], request: IMcpRequestContext): McpTool[];

    /**
     * The extension exists only in the stateless revisions (2026-07-28 and
     * later): it is declared in `server/discover` and not at `initialize`, and
     * its methods answer `-32601` to a handshake session.
     */
    readonly statelessOnly?: boolean;

    /**
     * Flags the extension adds to `subscriptions/listen` (for instance
     * `"eventsListChanged"`). The server acknowledges a flag the client asked
     * for while the extension is declared; the extension then reaches those
     * listens with {@link IMcpExtensionHost.notifyListeners}.
     */
    readonly subscriptionFlags?: readonly string[];

    /** Behaviors registered with the extension, removed with it. */
    readonly behaviors?: readonly IMcpBehavior[];

    /** Called once, when the server takes the extension. */
    attach?(host: IMcpExtensionHost): void;

    /** Called when the server stops. */
    detach?(): void;
}
