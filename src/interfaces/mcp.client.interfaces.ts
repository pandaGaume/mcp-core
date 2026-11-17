import type { IEventSource } from "./eventSource";
import type {
    McpClientCapabilities,
    McpInitializeResult,
    McpServerCapabilities,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpServerInfo,
    McpTool,
} from "./mcp.core.interfaces";
import type { McpCompletion, McpCompletionArgument, McpCompletionReference, McpLoggingLevel, McpPrompt, McpPromptResult, McpToolResult } from "./mcp.behavior.interfaces";

/**
 * Per-call options of the client operations that run on the server.
 */
export interface McpRequestOptions {
    /**
     * Cancels the call. The client sends `notifications/cancelled`, forgets
     * the request, and rejects with an `AbortError`; a late answer from the
     * server is ignored, as the spec asks. The server may still have done part
     * of the work.
     */
    signal?: AbortSignal;
}

/**
 * Minimalist MCP client that connects to an MCP server via any {@link IMessageTransport}.
 *
 * Handles the JSON-RPC 2.0 protocol, the MCP initialization handshake, and
 * provides typed wrappers for the standard MCP operations (resources, tools).
 *
 * @example Loopback (same page)
 * ```typescript
 * const [serverEnd, clientEnd] = LoopbackTransport.createPair();
 * const server = new McpServerBuilder().withName("robot_1").withTransport(serverEnd).build();
 * await server.start();
 *
 * const client = new McpClient({ name: "robot_2", version: "1.0.0" }, clientEnd);
 * await client.connect();
 * const tools = await client.listTools();
 * ```
 *
 * @example Remote server over Streamable HTTP
 * ```typescript
 * const transport = new StreamableHttpTransport("https://example.com/mcp");
 * const client = new McpClient({ name: "robot_2", version: "1.0.0" }, transport);
 * await client.connect();
 * ```
 */
/** What an {@link McpClient} declares at `initialize`. */
export interface IMcpClientOptions {
    /**
     * The client capabilities sent at `initialize`, e.g.
     * `{ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }`.
     * Default `{}`.
     */
    readonly capabilities?: McpClientCapabilities;

    /**
     * Which protocol era to speak.
     * - `"legacy"` (default): the `initialize` handshake, revisions up to 2025-11-25.
     * - `"stateless"`: revision 2026-07-28, no handshake; `connect()` calls
     *   `server/discover`, every request carries its `_meta`, and a server that
     *   does not answer it is an error.
     * - `"auto"`: the spec's probe: `server/discover` first, `initialize` when
     *   the server answers with anything but a stateless result or a recognized
     *   stateless error, or not within {@link probeTimeoutMs}.
     */
    readonly protocol?: "legacy" | "auto" | "stateless";

    /** How long `"auto"` waits for `server/discover` before assuming an older server. @default 5000 */
    readonly probeTimeoutMs?: number;
}

/** A server-to-client notification, as {@link IMcpClient.onNotification} reports it. */
export interface McpNotificationMessage {
    readonly method: string;
    readonly params?: unknown;
}

export interface IMcpClient {
    /** Human-readable name of this client. */
    readonly name: string;

    /** Whether the client has completed the MCP handshake and is ready. */
    readonly isConnected: boolean;

    /** Server identity received during the initialization handshake. */
    readonly serverInfo: McpServerInfo | undefined;

    /**
     * The MCP protocol revision negotiated with the server, or `undefined`
     * before the handshake completes and after {@link disconnect}.
     */
    readonly protocolVersion: string | undefined;

    /** The capabilities the server declared. Optional so existing implementations keep compiling. */
    readonly serverCapabilities?: McpServerCapabilities;

    /** The settings the server declared for one extension, `undefined` when it did not. */
    serverExtension?(extensionId: string): Readonly<Record<string, unknown>> | undefined;

    /** Every server notification, raw. */
    readonly onNotification?: IEventSource<McpNotificationMessage>;

    /** Sends any request and resolves with its raw result. */
    request?<T = unknown>(method: string, params?: unknown, options?: McpRequestOptions): Promise<T>;

    /**
     * Opens the transport, performs the MCP `initialize` handshake, and sends
     * `notifications/initialized`. Resolves with the server's init result.
     *
     * Rejects when the server answers with a protocol revision this client
     * cannot speak, closing the transport as the spec recommends.
     */
    connect(): Promise<McpInitializeResult>;

    /** Closes the transport and rejects any pending requests. */
    disconnect(): void;

    /** Sends a `ping` and resolves when the server answers. */
    ping(): Promise<void>;

    // ── Resources ────────────────────────────────────────────────────────

    /** Calls `resources/list` on the server. */
    listResources(): Promise<McpResource[]>;

    /** Calls `resources/templates/list` on the server. */
    listResourceTemplates(): Promise<McpResourceTemplate[]>;

    /** Calls `resources/read` for the given URI. */
    readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContent>;

    // ── Tools ────────────────────────────────────────────────────────────

    /** Calls `tools/list` on the server. */
    listTools(): Promise<McpTool[]>;

    /** Calls `tools/call` with the given tool name and arguments. */
    callTool(name: string, args: Record<string, unknown>, options?: McpRequestOptions): Promise<McpToolResult>;

    // ── Notifications ────────────────────────────────────────────────────

    /** Emitted when the server sends `notifications/resources/list_changed`. */
    onResourcesChanged: IEventSource<void> | null;

    /** Emitted when the server sends `notifications/tools/list_changed`. */
    onToolsChanged: IEventSource<void> | null;

    // The members below are optional so an existing implementation of this
    // interface keeps compiling. `McpClient` provides all of them.

    /** Calls `resources/subscribe`; updates then arrive on {@link onResourceUpdated}. */
    subscribeResource?(uri: string): Promise<void>;

    /** Calls `resources/unsubscribe`. */
    unsubscribeResource?(uri: string): Promise<void>;

    /** Emitted with the URI of each `notifications/resources/updated`. */
    readonly onResourceUpdated?: IEventSource<string>;

    /** Calls `prompts/list`, draining every page. */
    listPrompts?(): Promise<McpPrompt[]>;

    /** Calls `prompts/get`. */
    getPrompt?(name: string, args?: Record<string, string>, options?: McpRequestOptions): Promise<McpPromptResult>;

    /** Emitted when the server sends `notifications/prompts/list_changed`. */
    readonly onPromptsChanged?: IEventSource<void>;

    /** Calls `completion/complete`. */
    complete?(ref: McpCompletionReference, argument: McpCompletionArgument, context?: { arguments?: Record<string, string> }): Promise<McpCompletion>;

    /** Calls `logging/setLevel`. */
    setLoggingLevel?(level: McpLoggingLevel): Promise<void>;
}
