import type { ServerResponse } from "node:http";
import type { IMessageTransport } from "../interfaces";

/** JSON-RPC identifier, as carried by a request awaiting a response. */
type JsonRpcId = string | number;

/**
 * Where a frame produced by the server should be written.
 *
 * A response belongs to the POST that carried its request; anything the server
 * originates on its own goes to the standalone GET stream.
 */
type Sink = { type: "post"; res: ServerResponse } | { type: "stream" };

/**
 * The server end of one Streamable HTTP session, seen by {@link McpServer} as an
 * ordinary transport.
 *
 * The correlation problem it solves: `send()` hands over a serialized frame and
 * nothing else, so the transport alone must work out which HTTP exchange that
 * frame answers. It does so by JSON-RPC id: a response whose id matches a
 * request delivered by a POST is written back on that POST, everything else is
 * server-initiated and goes to the GET stream.
 */
export class HttpSessionTransport implements IMessageTransport {
    public onMessage: ((data: string) => void) | null = null;
    public onOpen: (() => void) | null = null;
    public onClose: (() => void) | null = null;
    public onError: ((error: Error) => void) | null = null;

    /** Request ids delivered by a POST still awaiting their response. */
    private readonly _pending = new Map<JsonRpcId, Sink>();

    /** The held-open SSE response for server-initiated messages, when a client opened one. */
    private _stream: ServerResponse | null = null;

    /** Frames produced before any GET stream existed, replayed when one opens. */
    private readonly _backlog: string[] = [];

    private _open = false;

    constructor(readonly sessionId: string) {}

    get isOpen(): boolean {
        return this._open;
    }

    /** Opens the transport so the owning server resolves its `start()`. */
    connect(): void {
        if (this._open) return;
        this._open = true;
        queueMicrotask(() => this.onOpen?.());
    }

    // -------------------------------------------------------------------------
    // Inbound: the HTTP layer feeds the session
    // -------------------------------------------------------------------------

    /**
     * Delivers one JSON-RPC frame received on a POST.
     *
     * @param res - The response to answer on, when the frame is a request.
     * @returns `true` when a reply is owed on `res`, `false` when the caller
     *          should acknowledge with `202` because nothing will answer.
     */
    deliver(frame: string, res: ServerResponse): boolean {
        const id = requestId(frame);
        if (id !== undefined) this._pending.set(id, { type: "post", res });

        this.onMessage?.(frame);
        return id !== undefined;
    }

    /**
     * Attaches the standalone SSE stream. Any frame produced while no stream was
     * attached is flushed first, so a notification emitted during initialization
     * is not lost.
     */
    attachStream(res: ServerResponse): void {
        this._stream = res;
        for (const frame of this._backlog.splice(0)) this._writeEvent(res, frame);
    }

    /** Detaches the SSE stream, without ending the session. */
    detachStream(res: ServerResponse): void {
        if (this._stream === res) this._stream = null;
    }

    // -------------------------------------------------------------------------
    // Outbound: the server produces frames
    // -------------------------------------------------------------------------

    send(data: string): void {
        if (!this._open) return;

        const id = responseId(data);
        const sink = id !== undefined ? this._pending.get(id) : undefined;
        if (sink && sink.type === "post") {
            this._pending.delete(id as JsonRpcId);
            sink.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            sink.res.end(data);
            return;
        }

        // Server-initiated, or a response whose POST is already gone: the GET
        // stream is the only way out. Buffer until one exists.
        if (this._stream) this._writeEvent(this._stream, data);
        else this._backlog.push(data);
    }

    close(): void {
        if (!this._open) return;
        this._open = false;

        // Nothing will answer these now; leaving them hanging would keep the
        // client waiting for its own timeout.
        for (const [, sink] of this._pending) {
            if (sink.type === "post" && !sink.res.writableEnded) {
                sink.res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
                sink.res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Session closed" } }));
            }
        }
        this._pending.clear();

        this._stream?.end();
        this._stream = null;
        this._backlog.length = 0;

        this.onClose?.();
    }

    private _writeEvent(res: ServerResponse, data: string): void {
        res.write(`event: message\ndata: ${data}\n\n`);
    }
}

/** The id of a frame that is a request awaiting a response, else `undefined`. */
function requestId(frame: string): JsonRpcId | undefined {
    const message = parse(frame);
    if (!message || typeof message.method !== "string") return undefined;
    return typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
}

/** The id of a frame that is a response, else `undefined`. */
function responseId(frame: string): JsonRpcId | undefined {
    const message = parse(frame);
    if (!message || message.method !== undefined) return undefined;
    return typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
}

function parse(frame: string): { id?: unknown; method?: unknown } | undefined {
    try {
        const parsed: unknown = JSON.parse(frame);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
        return parsed as { id?: unknown; method?: unknown };
    } catch {
        return undefined;
    }
}
