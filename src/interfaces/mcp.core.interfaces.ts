import { JsonRpcRequest, JsonRpcResponse } from "./mcp.jsonrpc.interfaces";

// ---------------------------------------------------------------------------
// Shared metadata primitives
// ---------------------------------------------------------------------------

/**
 * Free-form metadata attached to almost any MCP object.
 *
 * The protocol reserves keys prefixed with `modelcontextprotocol.io/` for
 * itself; everything else is available to applications for their own purposes.
 * Receivers must ignore what they do not understand.
 */
export type McpMeta = { [key: string]: unknown };

/**
 * An icon a client may display next to a tool, resource, template or prompt.
 *
 * @example
 * ```typescript
 * const icon: McpIcon = { src: "https://example.com/icon.png", mimeType: "image/png", sizes: ["48x48"] };
 * ```
 */
export interface McpIcon {
    /** URI of the icon. May be an `https:` URL or a `data:` URI. */
    src: string;

    /** MIME type of the image, e.g. `"image/png"` or `"image/svg+xml"`. */
    mimeType?: string;

    /** Rendered sizes, in the HTML `sizes` syntax, e.g. `["48x48"]` or `["any"]`. */
    sizes?: string[];
}

/**
 * Hints about how a client should use or display a piece of content.
 *
 * Purely advisory: a client is free to ignore them. Resources, resource
 * templates and every content block accept the same shape.
 */
export interface McpAnnotations {
    /** Who the content is meant for. `"user"`, `"assistant"`, or both. */
    audience?: ("user" | "assistant")[];

    /** Importance from 0.0 (entirely optional) to 1.0 (effectively required). */
    priority?: number;

    /** ISO 8601 timestamp of the last modification, e.g. `"2025-01-12T15:00:58Z"`. */
    lastModified?: string;
}

/**
 * The naming pair shared by every addressable MCP object.
 *
 * `name` is the programmatic identifier, stable and used for lookups; `title`
 * is what a user interface should show instead when it is present. Splitting
 * the two lets a name stay machine-friendly without making it unreadable.
 */
export interface McpBaseMetadata {
    /** Programmatic identifier. Unique within its own list. */
    name: string;

    /** Human-readable display name. Clients prefer it over {@link name} in a UI. */
    title?: string;
}

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
export interface McpResourceTemplate extends McpBaseMetadata {
    /** RFC 6570 URI template, e.g. `"mesh://scene/{meshName}"`. */
    uriTemplate: string;

    /** Optional description of what resources matching this template represent. */
    description?: string;

    /** Optional MIME type of the content returned by `resources/read` for these URIs. */
    mimeType?: string;

    /** Display hints for clients: intended audience, priority, last modification. */
    annotations?: McpAnnotations;

    /** Icons a client may show next to this template. */
    icons?: McpIcon[];

    /** Application-defined metadata. */
    _meta?: McpMeta;
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
export interface McpResource extends McpBaseMetadata {
    /**
     * Unique identifier for the resource, formatted as a URI.
     * Supports standard schemes such as `file://`, `https://`, or custom ones.
     */
    uri: string;

    /**
     * MIME type of the resource content (e.g. `"text/plain"`, `"application/json"`).
     *
     * Optional, as the spec has it: a server that cannot tell may leave it out
     * rather than guess.
     */
    mimeType?: string;

    /** Optional human-readable description of what the resource contains. */
    description?: string;

    /** Size in bytes, when known. Lets a client budget before reading. */
    size?: number;

    /** Display hints for clients: intended audience, priority, last modification. */
    annotations?: McpAnnotations;

    /** Icons a client may show next to this resource. */
    icons?: McpIcon[];

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/** Fields common to both flavours of {@link McpResourceContent}. */
export interface McpResourceContentBase {
    /** URI of the resource this content belongs to, matching {@link McpResource.uri}. */
    uri: string;

    /** MIME type of the content (e.g. `"text/plain"`, `"application/json"`). */
    mimeType?: string;

    /** Display hints for clients: intended audience, priority, last modification. */
    annotations?: McpAnnotations;

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/** Resource content carried as text. */
export interface McpTextResourceContent extends McpResourceContentBase {
    /** The raw text content of the resource. */
    text: string;

    blob?: never;
}

/** Resource content carried as base64-encoded binary. */
export interface McpBlobResourceContent extends McpResourceContentBase {
    /** Base64-encoded binary content. */
    blob: string;

    text?: never;
}

/**
 * Holds the actual content of a resource retrieved from an MCP server.
 * Returned in response to a `resources/read` request.
 *
 * Either textual or binary, never both. Narrow on the field you need:
 *
 * ```typescript
 * if ("text" in content && content.text !== undefined) { ... } else { ...content.blob }
 * ```
 *
 * @see {@link McpResource} for the resource metadata counterpart.
 */
export type McpResourceContent = McpTextResourceContent | McpBlobResourceContent;

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
export interface McpTool extends McpBaseMetadata {
    /** Human-readable explanation of what the tool does and when to use it. */
    description?: string;

    /**
     * JSON Schema object describing the expected input parameters.
     * Clients and LLMs use this schema to validate and construct arguments before calling the tool.
     *
     * Must be a valid schema object, never `null`. For a tool that takes no
     * argument, prefer `{ type: "object", additionalProperties: false }` over
     * the looser `{ type: "object" }`. The dialect defaults to JSON Schema
     * 2020-12 unless the object carries its own `$schema`.
     */
    inputSchema: object;

    /**
     * JSON Schema describing the shape of {@link McpToolResult.structuredContent}.
     *
     * When present the server must return structured results that conform to it,
     * and clients are expected to validate against it. Declaring it is what lets
     * a caller treat the result as typed data rather than a blob of text.
     */
    outputSchema?: object;

    /** Behavioural hints. Untrusted unless the server itself is trusted. */
    annotations?: McpToolAnnotations;

    /** Icons a client may show next to this tool. */
    icons?: McpIcon[];

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/**
 * Hints describing how a tool behaves, so a client can decide what needs
 * confirmation and what can run freely.
 *
 * All of them are advisory and, per the spec, must be treated as untrusted
 * unless they come from a trusted server: a hostile server can claim anything
 * here. Use them to improve a UI, never as a security boundary.
 */
export interface McpToolAnnotations {
    /** Display name for the tool, overriding {@link McpTool.name} in a UI. */
    title?: string;

    /** The tool does not modify its environment. */
    readOnlyHint?: boolean;

    /** The tool may perform destructive updates. Only meaningful when not read-only. */
    destructiveHint?: boolean;

    /** Calling the tool again with the same arguments has no additional effect. */
    idempotentHint?: boolean;

    /** The tool touches an open world (the internet, say) rather than a closed domain. */
    openWorldHint?: boolean;
}

/**
 * Identity of one side of an MCP connection, exchanged during the `initialize`
 * handshake. Both {@link McpClientInfo} and {@link McpServerInfo} are this
 * shape; the two aliases exist to keep call sites readable.
 */
export interface McpImplementation extends McpBaseMetadata {
    /** Version string of the implementation (e.g. `"1.0.0"`). */
    version: string;

    /** One-line description, matching the MCP registry `server.json` format. */
    description?: string;

    /** Icons a client may show for this implementation. */
    icons?: McpIcon[];

    /** Homepage or documentation URL. */
    websiteUrl?: string;

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/**
 * Identifies an MCP client application.
 * Sent by the client during the `initialize` handshake.
 */
export type McpClientInfo = McpImplementation;

/**
 * Identifies an MCP server implementation.
 * Returned by the server during the `initialize` handshake.
 */
export type McpServerInfo = McpImplementation;

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
    sampling?: McpCapabilityFlag;

    /**
     * Indicates the client can prompt its user on the server's behalf.
     * `form` covers schema-driven forms, `url` the redirect-to-a-URL flow.
     */
    elicitation?: {
        form?: McpCapabilityFlag;
        url?: McpCapabilityFlag;
    };

    /** Indicates the client accepts task-augmented requests from the server. */
    tasks?: McpTasksCapability;

    /** Non-standard features, keyed by name. */
    experimental?: { [feature: string]: unknown };
}

/**
 * A capability that carries no options today.
 *
 * Declared as an open object rather than `Record<string, never>` so a peer
 * announcing sub-options from a newer revision still type-checks: the protocol
 * is explicit that unknown fields are to be ignored, not rejected.
 */
export type McpCapabilityFlag = { [option: string]: unknown };

/**
 * Support for task-augmented requests, the experimental mechanism added in
 * revision 2025-11-25 for long-running work polled instead of awaited.
 *
 * The nested `requests` map names the methods that may be task-augmented, e.g.
 * `{ requests: { tools: { call: {} } } }` on a server.
 */
export interface McpTasksCapability {
    /** The peer supports `tasks/list`. */
    list?: McpCapabilityFlag;

    /** The peer supports `tasks/cancel`. */
    cancel?: McpCapabilityFlag;

    /** Methods that accept task augmentation, nested as `group → method`. */
    requests?: { [group: string]: { [method: string]: unknown } };
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
    logging?: McpCapabilityFlag;

    /** Indicates the server supports argument autocompletion via `completion/complete`. */
    completions?: McpCapabilityFlag;

    /** Indicates the server accepts task-augmented requests from the client. */
    tasks?: McpTasksCapability;

    /** Non-standard features, keyed by name. */
    experimental?: { [feature: string]: unknown };
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
