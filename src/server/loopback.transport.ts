import type { IMessageTransport } from "../interfaces";

// ---------------------------------------------------------------------------
// LoopbackEnd — one side of a loopback pair (internal)
// ---------------------------------------------------------------------------

/**
 * One endpoint of a {@link LoopbackTransport} pair.
 * Messages sent on this end are delivered to the peer's `onMessage` callback
 * via `queueMicrotask` to avoid synchronous re-entrancy issues.
 */
class LoopbackEnd implements IMessageTransport {
    _peer!: LoopbackEnd;
    private _open = false;

    /** Whether `onOpen` has already been dispatched for this end since it opened. */
    private _opened = false;

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    get isOpen(): boolean {
        return this._open;
    }

    /**
     * Opens this end and its peer, and dispatches `onOpen` asynchronously.
     *
     * Each end is notified once. The peer is only notified here if it already
     * registered a handler; otherwise its notification waits until it calls
     * `connect()` itself. That is what makes the usual pairing work whichever
     * side opens first: a server started before its client still lets the
     * client run its handshake when it connects later.
     */
    connect(): void {
        this._open = true;
        this._peer._open = true;
        this._notifyOpen();
        if (this._peer.onOpen) this._peer._notifyOpen();
    }

    private _notifyOpen(): void {
        if (this._opened) return;
        this._opened = true;
        queueMicrotask(() => this.onOpen?.());
    }

    send(data: string): void {
        if (!this._open) return;
        // Deliver to peer asynchronously to match network transport semantics.
        queueMicrotask(() => this._peer.onMessage?.(data));
    }

    close(): void {
        if (!this._open) return;
        this._open = false;
        this._peer._open = false;
        // Allow a later connect() to notify both ends again.
        this._opened = false;
        this._peer._opened = false;
        queueMicrotask(() => this.onClose?.());
        queueMicrotask(() => this._peer.onClose?.());
    }
}

// ---------------------------------------------------------------------------
// LoopbackTransport — factory for in-process transport pairs
// ---------------------------------------------------------------------------

/**
 * Creates a pair of in-process transports connected back-to-back.
 *
 * Messages sent on one end are delivered to the other's `onMessage` callback
 * without any network overhead — ideal for same-page server↔client
 * communication.
 *
 * @example
 * ```typescript
 * const [serverEnd, clientEnd] = LoopbackTransport.createPair();
 *
 * // Pass serverEnd to McpServerBuilder.withTransport()
 * // Pass clientEnd to new McpClient(info, clientEnd)
 * ```
 */
export class LoopbackTransport {
    /**
     * Returns a connected pair `[serverEnd, clientEnd]`.
     * Either side can call `connect()` to open both ends simultaneously.
     */
    static createPair(): [IMessageTransport, IMessageTransport] {
        const a = new LoopbackEnd();
        const b = new LoopbackEnd();
        a._peer = b;
        b._peer = a;
        return [a, b];
    }
}
