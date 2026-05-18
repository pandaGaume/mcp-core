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

    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    get isOpen(): boolean {
        return this._open;
    }

    /**
     * Opens this end and its peer. Both sides receive `onOpen` asynchronously.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    connect(): void {
        if (this._open) return;
        this._open = true;
        this._peer._open = true;
        queueMicrotask(() => this.onOpen?.());
        queueMicrotask(() => this._peer.onOpen?.());
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
