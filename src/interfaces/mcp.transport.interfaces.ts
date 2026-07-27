/**
 * Abstraction over the raw communication channel between an {@link IMcpServer}
 * and its relay (typically a {@link WsTunnel}).
 *
 * Two built-in implementations are provided:
 * - {@link DirectTransport} — 1 server : 1 WebSocket (default).
 * - {@link MultiplexTransport} — N servers : 1 WebSocket via an envelope protocol.
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
