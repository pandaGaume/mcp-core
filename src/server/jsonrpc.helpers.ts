import type {
    JsonRpcError,
    JsonRpcNotification,
    JsonRpcResponse,
    McpInitializeResult,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpTool,
    McpToolResult,
} from "../interfaces";

// ---------------------------------------------------------------------------
// Generic JSON-RPC 2.0 builders
// ---------------------------------------------------------------------------

/**
 * Builds a successful JSON-RPC 2.0 response.
 *
 * @param id     - The request id to echo back.
 * @param result - The result payload. May be any serializable value.
 */
export function jsonRpcOk(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

/**
 * Builds a JSON-RPC 2.0 error response.
 *
 * @param id      - The request id to echo back, or `null` for parse errors where
 *                  the id could not be determined (cast required by the interface).
 * @param code    - Numeric error code. Standard ranges: -32768 to -32000 are reserved.
 * @param message - Human-readable error description.
 * @param data    - Optional additional diagnostic data.
 */
export function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    const error: JsonRpcError = data !== undefined ? { code, message, data } : { code, message };
    // id is null for parse errors per the JSON-RPC 2.0 spec; the interface
    // does not model null here, so a cast is required.
    return { jsonrpc: "2.0", id: id as string | number, error };
}

// ---------------------------------------------------------------------------
// MCP-specific helpers
// ---------------------------------------------------------------------------

/**
 * Named helpers for the MCP protocol, built on top of the generic JSON-RPC builders.
 *
 * **Error builders** use standard JSON-RPC / MCP error codes so callers never
 * have to remember magic numbers.
 *
 * **Result builders** encode the exact wire shapes required by the MCP spec so
 * handler code reads as pure domain logic, free of protocol boilerplate.
 *
 * @example
 * ```typescript
 * // Instead of:
 * return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "…" }] } };
 *
 * // Write:
 * return Mcp.toolCallResult(req.id, "…");
 * ```
 */
export const Mcp = {
    // ── Errors ───────────────────────────────────────────────────────────────

    /** `-32700` — request body could not be parsed as JSON. `id` is `null` per spec. */
    parseError: (): JsonRpcResponse => jsonRpcError(null, -32700, "Parse error"),

    /** `-32601` — the requested method does not exist on this server. */
    methodNotFound: (id: string | number, method: string): JsonRpcResponse => jsonRpcError(id, -32601, `Method not found: ${method}`),

    /** `-32602` — required parameters are missing or malformed. */
    invalidParams: (id: string | number, message: string): JsonRpcResponse => jsonRpcError(id, -32602, message),

    /** `-32603` — an unexpected error occurred while processing the request. */
    internalError: (id: string | number, message: string): JsonRpcResponse => jsonRpcError(id, -32603, message),

    /** `-32002` — no resource matched the given URI. */
    resourceNotFound: (id: string | number, uri: string): JsonRpcResponse => jsonRpcError(id, -32002, `Resource not found: ${uri}`),

    /** `-32002` — no attached behavior instance matched the given URI. */
    instanceNotFound: (id: string | number, uri: string): JsonRpcResponse => jsonRpcError(id, -32002, `Instance not found: ${uri}`),

    /** `-32601` — no tool matched the given name. */
    toolNotFound: (id: string | number, name: string): JsonRpcResponse => jsonRpcError(id, -32601, `Tool not found: ${name}`),

    // ── Results ──────────────────────────────────────────────────────────────

    /** Wraps an `initialize` result. */
    initializeResult: (id: string | number, result: McpInitializeResult): JsonRpcResponse => jsonRpcOk(id, result),

    /** Wraps a `resources/list` result. */
    resourcesListResult: (id: string | number, resources: McpResource[]): JsonRpcResponse => jsonRpcOk(id, { resources }),

    /** Wraps a `resources/templates/list` result. */
    resourcesTemplatesListResult: (id: string | number, resourceTemplates: McpResourceTemplate[]): JsonRpcResponse => jsonRpcOk(id, { resourceTemplates }),

    /**
     * Wraps a `resources/read` result.
     * The MCP spec wraps content in an array (`contents`) to allow future multi-part reads.
     */
    resourcesReadResult: (id: string | number, content: McpResourceContent): JsonRpcResponse => jsonRpcOk(id, { contents: [content] }),

    /** Wraps a `tools/list` result. */
    toolsListResult: (id: string | number, tools: McpTool[]): JsonRpcResponse => jsonRpcOk(id, { tools }),

    /**
     * Wraps a `tools/call` result as a single text content block.
     * Pass a pre-serialized JSON string for structured data.
     */
    toolCallResult: (id: string | number, result: McpToolResult): JsonRpcResponse => jsonRpcOk(id, { content: result.content, isError: result.isError ?? false }),

    // ── Server-sent notifications ─────────────────────────────────────────────

    /** Notifies the client that the resource list has changed (`notifications/resources/list_changed`). */
    resourcesListChanged: (): JsonRpcNotification => ({ jsonrpc: "2.0", method: "notifications/resources/list_changed" }),

    /** Notifies the client that the tool list has changed (`notifications/tools/list_changed`). */
    toolsListChanged: (): JsonRpcNotification => ({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
} as const;
