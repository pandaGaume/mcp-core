/**
 * Represents a JSON-RPC 2.0 request object sent from client to server.
 *
 * @see {@link https://www.jsonrpc.org/specification#request_object JSON-RPC 2.0 Specification}
 *
 * @example
 * ```typescript
 * const request: JsonRpcRequest = {
 *     jsonrpc: "2.0",
 *     id: 1,
 *     method: "tools/list",
 *     params: { cursor: undefined },
 * };
 * ```
 */
export interface JsonRpcRequest {
    /** JSON-RPC protocol version. Must always be `"2.0"`. */
    jsonrpc: "2.0";

    /**
     * Request identifier used to match responses to requests.
     * Must be unique within a session. Can be a string or integer.
     */
    id: string | number;

    /** The name of the remote method to invoke. */
    method: string;

    /** Optional parameters to pass to the method. Structure depends on the method. */
    params?: unknown;
}

/**
 * Represents a JSON-RPC 2.0 response object returned by the server.
 * Contains either a `result` on success or an `error` on failure — never both.
 *
 * @see {@link https://www.jsonrpc.org/specification#response_object JSON-RPC 2.0 Specification}
 *
 * @example
 * ```typescript
 * // Success
 * const response: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
 *
 * // Failure
 * const response: JsonRpcResponse = { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid Request" } };
 * ```
 */
export interface JsonRpcResponse {
    /** JSON-RPC protocol version. Must always be `"2.0"`. */
    jsonrpc: "2.0";

    /** Identifier matching the originating {@link JsonRpcRequest}. */
    id: string | number;

    /** The result payload on success. Mutually exclusive with {@link JsonRpcResponse.error}. */
    result?: unknown;

    /** The error payload on failure. Mutually exclusive with {@link JsonRpcResponse.result}. */
    error?: JsonRpcError;
}

/**
 * Represents a JSON-RPC 2.0 notification — a request with no expected response.
 * Notifications do not carry an `id` field, so the server must not reply.
 *
 * @see {@link https://www.jsonrpc.org/specification#notification JSON-RPC 2.0 Specification}
 *
 * @example
 * ```typescript
 * const notification: JsonRpcNotification = {
 *     jsonrpc: "2.0",
 *     method: "notifications/progress",
 *     params: { progressToken: "abc", progress: 50, total: 100 },
 * };
 * ```
 */
export interface JsonRpcNotification {
    /** JSON-RPC protocol version. Must always be `"2.0"`. */
    jsonrpc: "2.0";

    /** The name of the method being notified. */
    method: string;

    /** Optional parameters associated with the notification. */
    params?: unknown;
}

/**
 * Represents a JSON-RPC 2.0 error object included in a failed {@link JsonRpcResponse}.
 *
 * Standard error codes:
 * - `-32700` — Parse error
 * - `-32600` — Invalid Request
 * - `-32601` — Method not found
 * - `-32602` — Invalid params
 * - `-32603` — Internal error
 *
 * @see {@link https://www.jsonrpc.org/specification#error_object JSON-RPC 2.0 Specification}
 */
export interface JsonRpcError {
    /**
     * Numeric error code indicating the type of failure.
     * Values from `-32768` to `-32000` are reserved for pre-defined errors.
     */
    code: number;

    /** Human-readable description of the error. */
    message: string;

    /** Optional additional information about the error. May be any serializable value. */
    data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export const JsonRpcMimeType = "application/json";
