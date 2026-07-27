import type { IEventSource } from "./eventSource";
import type { McpInitializeResult, McpResource, McpResourceContent, McpResourceTemplate, McpServerInfo, McpTool } from "./mcp.core.interfaces";
import type { McpToolResult } from "./mcp.behavior.interfaces";

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
 * @example Tunnel (cross-page)
 * ```typescript
 * const transport = new DirectTransport("ws://localhost:3000/robot_1");
 * const client = new McpClient({ name: "robot_2", version: "1.0.0" }, transport);
 * await client.connect();
 * ```
 */
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
    readResource(uri: string): Promise<McpResourceContent>;

    // ── Tools ────────────────────────────────────────────────────────────

    /** Calls `tools/list` on the server. */
    listTools(): Promise<McpTool[]>;

    /** Calls `tools/call` with the given tool name and arguments. */
    callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;

    // ── Notifications ────────────────────────────────────────────────────

    /** Emitted when the server sends `notifications/resources/list_changed`. */
    onResourcesChanged: IEventSource<void> | null;

    /** Emitted when the server sends `notifications/tools/list_changed`. */
    onToolsChanged: IEventSource<void> | null;
}
