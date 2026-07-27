import { JsonRpcRequest, JsonRpcResponse } from "./mcp.jsonrpc.interfaces";

/**
 * Describes a parameterized URI pattern for resources exposed by an MCP server.
 * Returned by `resources/templates/list` so clients can discover what kinds of
 * resources exist and how to construct valid URIs for them.
 *
 * URI templates follow RFC 6570 (variables are enclosed in `{` `}`).
 *
 * @example
 * ```typescript
 * const template: McpResourceTemplate = {
 *     uriTemplate: "mesh://scene/{meshName}",
 *     name: "Mesh",
 *     description: "A named mesh in the active scene.",
 *     mimeType: "application/json",
 * };
 * ```
 */
export interface McpResourceTemplate {
    /** RFC 6570 URI template, e.g. `"mesh://scene/{meshName}"`. */
    uriTemplate: string;

    /** Human-readable display name for this template category. */
    name: string;

    /** Optional description of what resources matching this template represent. */
    description?: string;

    /** Optional MIME type of the content returned by `resources/read` for these URIs. */
    mimeType?: string;
}

/**
 * Describes a resource exposed by an MCP server that clients can read.
 * Resources represent any kind of data: files, database records, API responses, etc.
 *
 * @see {@link https://modelcontextprotocol.io/docs/concepts/resources MCP Resources}
 *
 * @example
 * ```typescript
 * const resource: McpResource = {
 *     uri: "file:///project/src/index.ts",
 *     name: "index.ts",
 *     mimeType: "text/typescript",
 *     description: "Application entry point",
 * };
 * ```
 */
export interface McpResource {
    /**
     * Unique identifier for the resource, formatted as a URI.
     * Supports standard schemes such as `file://`, `https://`, or custom ones.
     */
    uri: string;

    /** Human-readable display name for the resource. */
    name: string;

    /** MIME type of the resource content (e.g. `"text/plain"`, `"application/json"`). */
    mimeType: string;

    /** Optional human-readable description of what the resource contains. */
    description?: string;
}

/**
 * Holds the actual content of a resource retrieved from an MCP server.
 * Returned in response to a `resources/read` request.
 *
 * @see {@link McpResource} for the resource metadata counterpart.
 */
export interface McpResourceContent {
    /** URI of the resource this content belongs to, matching {@link McpResource.uri}. */
    uri: string;

    /** MIME type of the content (e.g. `"text/plain"`, `"application/json"`). */
    mimeType: string;

    /** The raw text content of the resource. */
    text: string;
}

/**
 * Describes a tool exposed by an MCP server that clients can invoke.
 * Tools represent executable operations such as running a command, querying a database, or calling an API.
 *
 * @see {@link https://modelcontextprotocol.io/docs/concepts/tools MCP Tools}
 *
 * @example
 * ```typescript
 * const tool: McpTool = {
 *     name: "read_file",
 *     description: "Reads the content of a file at the given path.",
 *     inputSchema: {
 *         type: "object",
 *         properties: { path: { type: "string" } },
 *         required: ["path"],
 *     },
 * };
 * ```
 */
export interface McpTool {
    /** Unique name used to invoke this tool via `tools/call`. */
    name: string;

    /** Human-readable explanation of what the tool does and when to use it. */
    description: string;

    /**
     * JSON Schema object describing the expected input parameters.
     * Clients and LLMs use this schema to validate and construct arguments before calling the tool.
     */
    inputSchema: object;
}

/**
 * Identifies an MCP client application.
 * Sent by the client during the `initialize` handshake.
 */
export interface McpClientInfo {
    /** Human-readable name of the client application (e.g. `"My AI App"`). */
    name: string;

    /** Version string of the client application (e.g. `"1.0.0"`). */
    version: string;
}

/**
 * Identifies an MCP server implementation.
 * Returned by the server during the `initialize` handshake.
 */
export interface McpServerInfo {
    /** Human-readable name of the server (e.g. `"my-mcp-server"`). */
    name: string;

    /** Version string of the server (e.g. `"1.0.0"`). */
    version: string;
}

/**
 * Capabilities advertised by an MCP client during initialization.
 *
 * @see {@link https://modelcontextprotocol.io/docs/concepts/architecture MCP Architecture}
 */
export interface McpClientCapabilities {
    /**
     * Indicates the client supports root URIs.
     * `listChanged` signals the client will emit notifications when roots change.
     */
    roots?: {
        listChanged?: boolean;
    };

    /** Indicates the client supports LLM sampling requests initiated by the server. */
    sampling?: Record<string, never>;
}

/**
 * Capabilities advertised by an MCP server during initialization.
 * Each key corresponds to a feature group the server opts into.
 *
 * @see {@link https://modelcontextprotocol.io/docs/concepts/architecture MCP Architecture}
 */
export interface McpServerCapabilities {
    /**
     * Indicates the server exposes resources.
     * - `subscribe`: clients may subscribe to resource change notifications.
     * - `listChanged`: server will emit `notifications/resources/list_changed` when the list changes.
     */
    resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
    };

    /**
     * Indicates the server exposes tools.
     * `listChanged`: server will emit `notifications/tools/list_changed` when the list changes.
     */
    tools?: {
        listChanged?: boolean;
    };

    /**
     * Indicates the server exposes prompts.
     * `listChanged`: server will emit `notifications/prompts/list_changed` when the list changes.
     */
    prompts?: {
        listChanged?: boolean;
    };

    /** Indicates the server supports structured logging via `logging/setLevel`. */
    logging?: Record<string, never>;
}

/**
 * The domain-level result produced by {@link IMcpInitializer}.
 * Contains only the server-supplied parts of the handshake — protocol version,
 * identity, and optional instructions. Capabilities are intentionally excluded
 * here because they are derived automatically from registered behaviors at
 * runtime by the server.
 *
 * @see {@link McpInitializeResult} for the full wire-level response.
 */
export interface McpServerIdentity {
    /**
     * Pins the MCP protocol revision the server will answer with, bypassing
     * negotiation.
     *
     * Leave it undefined — the recommended form — and the server negotiates
     * against the revisions it supports: it echoes the revision the client
     * requested when it can honour it, and falls back to its newest otherwise.
     *
     * Set it only to force a specific revision (e.g. a downstream client that
     * misbehaves on newer ones). The value MUST be a revision the server can
     * actually speak, since the client is entitled to disconnect on a revision
     * it does not know.
     *
     * @see {@link negotiateProtocolVersion}
     */
    protocolVersion?: string;

    /** Metadata identifying this server implementation. */
    serverInfo: McpServerInfo;

    /**
     * Optional human-readable instructions for the client or LLM about
     * how to interact with this server (e.g. usage notes, constraints).
     */
    instructions?: string;
}

/**
 * Full result returned over the wire in response to an `initialize` request.
 * Built by the server by merging {@link McpServerIdentity} with auto-derived
 * capabilities from all registered behaviors.
 *
 * @see {@link https://modelcontextprotocol.io/docs/concepts/architecture MCP Architecture}
 */
export interface McpInitializeResult extends McpServerIdentity {
    /**
     * The revision agreed for this session. Unlike the optional pin on
     * {@link McpServerIdentity}, it is always present on the wire: the server
     * fills it from negotiation when the initializer did not pin one.
     */
    protocolVersion: string;

    /** The feature set this server supports, derived from registered behaviors. */
    capabilities: McpServerCapabilities;
}

/**
 * Handles JSON-RPC protocol-level MCP requests, routing them to the domain layer.
 *
 * Each method maps to one MCP protocol method:
 * - `initialize`              → `initialize`
 * - `resourcesList`           → `resources/list`
 * - `resourcesTemplatesList`  → `resources/templates/list`
 * - `resourcesRead`           → `resources/read`
 * - `toolsList`               → `tools/list`
 * - `toolsCall`               → `tools/call`
 * - `ping`                    → `ping`
 *
 * Aggregates results across all registered {@link IMcpBehavior}s and their instances.
 */
export interface IMcpServerHandlers {
    initialize(req: JsonRpcRequest): JsonRpcResponse;
    resourcesList(req: JsonRpcRequest): JsonRpcResponse;
    resourcesTemplatesList(req: JsonRpcRequest): JsonRpcResponse;
    resourcesRead(req: JsonRpcRequest): Promise<JsonRpcResponse>;
    toolsList(req: JsonRpcRequest): JsonRpcResponse;
    toolsCallAsync(req: JsonRpcRequest): Promise<JsonRpcResponse>;

    /**
     * Answers a `ping` request. Optional: when a custom handler leaves it out,
     * the server replies with the empty result the spec mandates, so a handler
     * only implements this to piggyback on ping (health probes, keep-alive
     * bookkeeping).
     */
    ping?(req: JsonRpcRequest): JsonRpcResponse;
}
