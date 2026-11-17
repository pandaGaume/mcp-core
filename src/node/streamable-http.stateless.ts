import type { ServerResponse } from "node:http";
import type { IMessageTransport } from "../interfaces";
import { MCP_ERROR_CODES } from "../mcp.protocol";

/** JSON-RPC identifier. */
type JsonRpcId = string | number;

/** Interval of SSE comment lines that keep a long-lived response (a listen) from idling out in proxies. */
const KEEP_ALIVE_MS = 25_000;

/**
 * The HTTP status a stateless (2026-07-28) error answer travels with, when
 * the response has not started streaming yet.
 */
function statusFor(code: number | undefined): number {
    if (code === undefined) return 200;
    // "If the server does not implement the requested RPC method, it MUST respond with 404."
    if (code === -32601) return 404;
    if (code === MCP_ERROR_CODES.headerMismatch || code === MCP_ERROR_CODES.missingRequiredClientCapability || code === MCP_ERROR_CODES.unsupportedProtocolVersion) return 400;
    return 200;
}

function parse(frame: string): { id?: unknown; method?: unknown; error?: { code?: unknown } } | undefined {
    try {
        const parsed: unknown = JSON.parse(frame);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { id?: unknown; method?: unknown; error?: { code?: unknown } }) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The server end of one stateless Streamable HTTP exchange (revision
 * 2026-07-28): one POST, one request, one server that lives exactly as long
 * as the exchange.
 *
 * The answer is a single `application/json` body when the server answers
 * before saying anything else. As soon as it sends a notification first (an
 * acknowledgement of `subscriptions/listen`, a log message, progress), the
 * response switches to `text/event-stream`, carries the notifications as they
 * come, and ends with the answer. No event ids: 2026-07-28 removed
 * resumption.
 */
export class StatelessRequestTransport implements IMessageTransport {
    public onMessage: ((data: string) => void) | null = null;
    public onOpen: (() => void) | null = null;
    public onClose: (() => void) | null = null;
    public onError: ((error: Error) => void) | null = null;

    private _open = false;
    private _streaming = false;
    private _answered = false;
    private _keepAlive: ReturnType<typeof setInterval> | undefined;

    /**
     * @param _res       - The POST's response.
     * @param _requestId - The id of the request the POST carries.
     * @param _onAnswered - Called once, when the answer is written or the exchange is abandoned.
     */
    constructor(
        private readonly _res: ServerResponse,
        private readonly _requestId: JsonRpcId,
        private readonly _onAnswered: () => void
    ) {}

    get isOpen(): boolean {
        return this._open && !this._answered;
    }

    /** `true` once the response is a stream: its status is sent, only events may follow. */
    get isStreaming(): boolean {
        return this._streaming;
    }

    connect(): void {
        if (this._open) return;
        this._open = true;
        queueMicrotask(() => this.onOpen?.());
    }

    /** Hands the POST's frame (or a synthesized cancellation) to the server. */
    deliver(frame: string): void {
        this.onMessage?.(frame);
    }

    send(data: string): void {
        if (!this.isOpen || this._res.writableEnded) return;
        const message = parse(data);
        const isAnswer = message !== undefined && message.method === undefined && message.id === this._requestId;

        if (isAnswer) {
            if (this._streaming) {
                this._writeEvent(data);
                this._res.end();
            } else {
                const code = typeof message.error?.code === "number" ? message.error.code : undefined;
                this._res.writeHead(statusFor(code), { "Content-Type": "application/json; charset=utf-8" });
                this._res.end(data);
            }
            this._finish();
            return;
        }

        // Anything before the answer (a notification of this request) streams.
        if (!this._streaming) {
            this._res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });
            this._streaming = true;
            this._keepAlive = setInterval(() => {
                if (!this._res.writableEnded) this._res.write(": keep-alive\n\n");
            }, KEEP_ALIVE_MS);
            this._keepAlive.unref?.();
        }
        this._writeEvent(data);
    }

    close(): void {
        if (!this._open) return;
        this._open = false;
        if (!this._answered && !this._res.writableEnded) {
            if (this._res.headersSent) this._res.end();
            else {
                this._res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
                this._res.end(JSON.stringify({ jsonrpc: "2.0", id: this._requestId, error: { code: -32603, message: "The server stopped before answering" } }));
            }
        }
        this._finish();
        this.onClose?.();
    }

    private _finish(): void {
        if (this._answered) return;
        this._answered = true;
        if (this._keepAlive) clearInterval(this._keepAlive);
        this._onAnswered();
    }

    private _writeEvent(data: string): void {
        this._res.write(`event: message\ndata: ${data}\n\n`);
    }
}

/**
 * Decodes a header value written with the 2026-07-28 sentinel
 * `=?base64?<base64 of UTF-8>?=`; any other value is returned as is.
 */
export function decodeMcpHeaderValue(value: string): string {
    const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
    return match ? Buffer.from(match[1], "base64").toString("utf8") : value;
}

/**
 * Encodes a header value for 2026-07-28: printable ASCII without surrounding
 * whitespace goes as is, anything else (and anything that looks like the
 * sentinel) as `=?base64?...?=`.
 */
export function encodeMcpHeaderValue(value: string): string {
    const plain = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value);
    return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Methods whose `Mcp-Name` header carries `params.name` (core, then the Events extension). */
const NAMED_METHODS: ReadonlySet<string> = new Set(["tools/call", "prompts/get", "events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);

/** The value `Mcp-Name` must carry for a method, `undefined` when the method takes none. */
export function mcpNameOf(method: string, params: unknown): string | undefined {
    const record = typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    const value = method === "resources/read" ? record["uri"] : NAMED_METHODS.has(method) ? record["name"] : undefined;
    return typeof value === "string" ? value : undefined;
}
