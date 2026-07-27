/**
 * Abstraction over the raw communication channel an MCP server or client
 * speaks through. The protocol layer never opens a connection itself: it is
 * handed one, so framing, reconnection and authentication stay with whoever
 * understands the medium.
 *
 * Built into this package: `StdioTransport` and `StreamableHttpTransport`
 * (`@cyanmycelium/mcp-core/node`), the two transports the MCP specification
 * defines, plus `LoopbackTransport` for in-process pairs. WebSocket tunnelling
 * to a broker lives in `@cyanmycelium/mcp-broker-provider`, since it is a
 * topology rather than a part of the specification.
 */
export interface IMessageTransport {
    /** Sends a serialized JSON-RPC message through the transport. */
    send(data: string): void;

    /** Called when a message arrives from the remote end. */
    onMessage: ((data: string) => void) | null;

    /** Called when the transport is ready to send/receive. */
    onOpen: (() => void) | null;

    /** Called when the transport closes (cleanly or not). */
    onClose: (() => void) | null;

    /** Called on transport-level errors. */
    onError: ((error: Error) => void) | null;

    /** Whether the transport is currently open and able to send. */
    readonly isOpen: boolean;

    /** Closes the transport. */
    close(): void;

    /**
     * Informs the transport of the MCP protocol revision negotiated during the
     * `initialize` handshake. An MCP client calls it as soon as the handshake
     * completes.
     *
     * Optional, because most transports carry no version metadata. HTTP-based
     * ones do: the spec requires an `MCP-Protocol-Version` header on every
     * request once initialization is done, and a server that never sees it
     * assumes revision `2025-03-26`.
     */
    setProtocolVersion?(version: string): void;
}
