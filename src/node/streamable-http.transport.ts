import * as http from "node:http";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { Socket } from "node:net";
import type { IMessageTransport } from "../interfaces";

/**
 * Options for the Node.js Streamable HTTP client transport.
 */
export interface IStreamableHttpTransportOptions {
    /** Extra headers sent with every HTTP request. */
    headers?: Readonly<Record<string, string>>;

    /**
     * MCP protocol revision advertised in the `MCP-Protocol-Version` header.
     *
     * The spec wants the revision negotiated during initialization, which is
     * only known once the handshake completes — prefer
     * {@link StreamableHttpTransport.setProtocolVersion}, which an MCP client
     * calls automatically. Set this only to force a value from the start.
     */
    protocolVersion?: string;

    /** Opens the standalone GET stream once the session is initialized. @default true */
    enableGetStream?: boolean;

    /**
     * Delay before re-opening an SSE stream the server closed, in milliseconds.
     * An SSE `retry` field sent by the server overrides it.
     * @default 1000
     */
    reconnectDelayMs?: number;

    /**
     * Send an HTTP DELETE on {@link StreamableHttpTransport.close} to terminate
     * the MCP session server-side, as the spec recommends.
     * @default true
     */
    terminateSessionOnClose?: boolean;
}

/** A decoded Server-Sent Event. `data` is empty for priming or `retry`-only events. */
interface SseEvent {
    event: string;
    data: string;
    id?: string;
    retry?: number;
}

/**
 * Incremental Server-Sent Events decoder used by POST and standalone GET streams.
 *
 * Beyond `event` and `data` it surfaces `id` and `retry`, which MCP relies on:
 * `id` is the cursor replayed through `Last-Event-ID` when resuming a broken
 * stream, and `retry` is the reconnection delay the client must honour.
 */
class SseDecoder {
    private _buffer = "";

    feed(chunk: string, emit: (event: SseEvent) => void): void {
        this._buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let separator = this._buffer.indexOf("\n\n");
        while (separator !== -1) {
            const block = this._buffer.slice(0, separator);
            this._buffer = this._buffer.slice(separator + 2);
            this._emitBlock(block, emit);
            separator = this._buffer.indexOf("\n\n");
        }
    }

    private _emitBlock(block: string, emit: (event: SseEvent) => void): void {
        let event = "message";
        let id: string | undefined;
        let retry: number | undefined;
        const data: string[] = [];

        for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);

            if (field === "event") event = value;
            else if (field === "data") data.push(value);
            else if (field === "id") id = value;
            else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
        }

        // A block carrying only an id still matters: the spec has servers prime a
        // stream with an id and an empty data field so the client can resume.
        if (data.length === 0 && id === undefined && retry === undefined) return;
        emit({ event, data: data.join("\n"), id, retry });
    }
}

function makeRequest(url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest {
    return url.protocol === "https:" ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
}

/** JSON-RPC identifier, as carried by a request awaiting a response. */
type JsonRpcId = string | number;

/**
 * Returns the id of an outgoing frame when it is a request awaiting a response.
 *
 * Notifications and responses yield `undefined`: nothing is pending on them, so
 * a transport failure has no request to be reported against.
 */
function pendingRequestId(frame: string): JsonRpcId | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(frame);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const { id, method } = parsed as { id?: unknown; method?: unknown };
    if (typeof method !== "string") return undefined;
    return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** Parses a body that may be the JSON-RPC error response the spec allows servers to return. */
function asJsonRpcError(body: string): { id?: JsonRpcId; error: unknown } | undefined {
    if (!body) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return "error" in parsed ? (parsed as { id?: JsonRpcId; error: unknown }) : undefined;
}

/** Timers are unref'd so a pending reconnection never keeps the process alive. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * MCP Streamable HTTP client transport for Node.js.
 *
 * JSON-RPC frames are sent with HTTP POST. Responses may be regular JSON or
 * Server-Sent Events. When the server creates an MCP session, the transport
 * retains its `Mcp-Session-Id`; it also opens the standalone GET stream used
 * for server-initiated messages, re-establishing it with `Last-Event-ID` when
 * the server closes the connection — which the spec explicitly allows a server
 * to do at any time.
 *
 * A session the server has terminated (HTTP 404) surfaces as a transport close,
 * since recovering means running a fresh `initialize`, which is the owning
 * client's job rather than the transport's.
 */
export class StreamableHttpTransport implements IMessageTransport {
    public onMessage: ((data: string) => void) | null = null;
    public onOpen: (() => void) | null = null;
    public onClose: (() => void) | null = null;
    public onError: ((error: Error) => void) | null = null;

    private readonly _url: URL;
    private readonly _headers: Readonly<Record<string, string>>;
    private readonly _enableGetStream: boolean;
    private readonly _terminateSessionOnClose: boolean;
    private readonly _baseReconnectDelayMs: number;

    /** In-flight requests and their responses, so `close()` can abort every one. */
    private readonly _requests = new Set<ClientRequest>();
    private readonly _responses = new Set<IncomingMessage>();

    private _protocolVersion: string | undefined;
    private _sessionId: string | null = null;
    private _open = false;

    private _getStreamRequest: ClientRequest | null = null;
    private _getStreamTimer: ReturnType<typeof setTimeout> | null = null;

    /** Set when the server answered the GET with 405 or a client error: stop retrying. */
    private _getStreamDisabled = false;

    /** Cursor for resumption, taken from the `id` field of the last SSE event. */
    private _lastEventId: string | undefined;

    /** Current reconnection delay, overridden by any SSE `retry` field. */
    private _reconnectDelayMs: number;

    constructor(url: string | URL, options: IStreamableHttpTransportOptions = {}) {
        this._url = new URL(url);
        if (this._url.protocol !== "http:" && this._url.protocol !== "https:") {
            throw new Error(`StreamableHttpTransport: unsupported URL protocol "${this._url.protocol}"`);
        }
        this._headers = { ...options.headers };
        this._protocolVersion = options.protocolVersion;
        this._enableGetStream = options.enableGetStream ?? true;
        this._terminateSessionOnClose = options.terminateSessionOnClose ?? true;
        this._baseReconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this._reconnectDelayMs = this._baseReconnectDelayMs;
    }

    public get isOpen(): boolean {
        return this._open;
    }

    /** The MCP session id assigned by the server, or `null` when it runs stateless. */
    public get sessionId(): string | null {
        return this._sessionId;
    }

    /**
     * Sets the revision sent in the `MCP-Protocol-Version` header, which the
     * spec requires on every request once initialization is done. An MCP client
     * calls this with the negotiated revision as soon as the handshake
     * completes; a server that never sees the header assumes `2025-03-26`.
     */
    public setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    public connect(): void {
        if (this._open) return;
        this._open = true;
        this._getStreamDisabled = false;
        this._reconnectDelayMs = this._baseReconnectDelayMs;
        queueMicrotask(() => {
            if (this._open) this.onOpen?.();
        });
    }

    public send(data: string): void {
        if (!this._open) return;
        const headers = this._requestHeaders({
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        });
        // Remember which JSON-RPC request this POST carries, so an HTTP-level
        // failure can be reported against it instead of leaving it hanging.
        const requestId = pendingRequestId(data);
        const request = this._request("POST", headers, (response) => this._handlePostResponse(response, requestId));
        request.end(data);
    }

    public close(): void {
        if (!this._open) return;
        this._terminateSession();
        this._teardown();
        this.onClose?.();
    }

    // -------------------------------------------------------------------------
    // Requests
    // -------------------------------------------------------------------------

    private _requestHeaders(required: Record<string, string>): Record<string, string> {
        const headers: Record<string, string> = { ...this._headers, ...required };
        if (this._protocolVersion) headers["MCP-Protocol-Version"] = this._protocolVersion;
        if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
        return headers;
    }

    /**
     * Issues a tracked request.
     *
     * The request stays tracked until its response is fully consumed, not merely
     * until the headers arrive: an SSE response is long-lived, and dropping it
     * early would leave `close()` with nothing to abort. Both the request and
     * the response carry an `error` listener, since an unhandled `error` event
     * on a Node stream is thrown rather than reported — and a broken connection
     * is routine on a long-lived stream.
     *
     * @param onFailure - Replaces the default {@link onError} reporting, so a
     *                    stream that recovers on its own stays quiet.
     */
    private _request(method: string, headers: Record<string, string>, onResponse: (response: IncomingMessage) => void, onFailure?: (error: Error) => void): ClientRequest {
        const request = makeRequest(this._url, { method, headers }, (response) => {
            if (!this._open) {
                this._requests.delete(request);
                response.resume();
                response.destroy();
                return;
            }

            this._responses.add(response);
            response.on("error", (error: Error) => {
                if (this._open && !onFailure) this.onError?.(error);
            });
            response.on("close", () => {
                this._responses.delete(response);
                this._requests.delete(request);
            });

            onResponse(response);
        });

        this._requests.add(request);
        request.on("error", (error: Error) => {
            this._requests.delete(request);
            if (!this._open) return;
            if (onFailure) onFailure(error);
            else this.onError?.(error);
        });

        return request;
    }

    // -------------------------------------------------------------------------
    // POST responses
    // -------------------------------------------------------------------------

    private _handlePostResponse(response: IncomingMessage, requestId: JsonRpcId | undefined): void {
        const status = response.statusCode ?? 0;

        // The server terminated the session: the spec requires a brand new
        // `initialize` without a session id, which only the client can do.
        // Pending requests are settled by the resulting close.
        if (status === 404 && this._sessionId) {
            response.resume();
            this._expireSession();
            return;
        }

        this._captureSession(response);

        if (status === 202 || status === 204) {
            response.resume();
            return;
        }

        if (status >= 400) {
            this._readBody(response, (body) => this._reportHttpFailure(status, body, requestId));
            return;
        }

        this._readResponse(response, requestId);
        this._maybeOpenGetStream();
    }

    private _readResponse(response: IncomingMessage, requestId: JsonRpcId | undefined): void {
        if (String(response.headers["content-type"] ?? "").includes("text/event-stream")) {
            // Resumption is always via GET with `Last-Event-ID`, whatever opened
            // the stream, so a broken POST stream hands over to the GET stream.
            this._consumeSse(response, () => this._scheduleGetStream());
            return;
        }

        this._readBody(response, (body) => this._emitJsonBody(body, requestId));
    }

    private _readBody(response: IncomingMessage, onBody: (body: string) => void): void {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
            body += chunk;
        });
        response.on("end", () => onBody(body.trim()));
    }

    private _emitJsonBody(body: string, requestId: JsonRpcId | undefined): void {
        if (!body) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            // Not JSON at all — a proxy error page, say. Forwarding it would let
            // the JSON-RPC layer drop it silently and the caller wait out its
            // timeout, so report it and settle the pending request instead.
            this._reportHttpFailure(200, body, requestId);
            return;
        }

        if (Array.isArray(parsed)) {
            for (const message of parsed) this.onMessage?.(JSON.stringify(message));
            return;
        }
        this.onMessage?.(body);
    }

    /**
     * Turns an HTTP-level failure into something the caller can act on.
     *
     * When the POST carried a JSON-RPC request, the failure is delivered as a
     * JSON-RPC error response for that id, so the pending call rejects at once
     * instead of waiting out its timeout. A server MAY answer with a JSON-RPC
     * error response of its own — that one is forwarded as-is, with the id
     * filled in when the server left it out. Failures that belong to no request
     * (a notification, a response) are reported through {@link onError}.
     */
    private _reportHttpFailure(status: number, body: string, requestId: JsonRpcId | undefined): void {
        const serverError = asJsonRpcError(body);
        if (serverError && requestId !== undefined) {
            this.onMessage?.(JSON.stringify({ ...serverError, id: serverError.id ?? requestId }));
            return;
        }

        const detail = body ? `: ${body.length > 200 ? `${body.slice(0, 200)}…` : body}` : "";
        const message = `Streamable HTTP ${status}${detail}`;

        if (requestId === undefined) {
            this.onError?.(new Error(message));
            return;
        }

        this.onMessage?.(
            JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                error: { code: -32000, message, data: { httpStatus: status } },
            })
        );
    }

    // -------------------------------------------------------------------------
    // SSE streams
    // -------------------------------------------------------------------------

    private _consumeSse(response: IncomingMessage, onEnd: () => void): void {
        const decoder = new SseDecoder();
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => decoder.feed(chunk, (event) => this._onSseEvent(event)));
        response.on("close", () => {
            if (this._open) onEnd();
        });
    }

    private _onSseEvent(event: SseEvent): void {
        if (event.id !== undefined) this._lastEventId = event.id;
        if (event.retry !== undefined) this._reconnectDelayMs = event.retry;
        if (event.event === "message" && event.data.length > 0) this.onMessage?.(event.data);
    }

    // -------------------------------------------------------------------------
    // Standalone GET stream
    // -------------------------------------------------------------------------

    /**
     * Opens the GET stream once, after initialization.
     *
     * The trigger is the first successful POST response rather than the arrival
     * of a session id: session management is optional, and a stateless server
     * would otherwise never get a server-to-client channel at all.
     */
    private _maybeOpenGetStream(): void {
        if (!this._enableGetStream || this._getStreamDisabled) return;
        if (this._getStreamRequest || this._getStreamTimer) return;
        this._openGetStream();
    }

    private _openGetStream(): void {
        if (!this._open || !this._enableGetStream || this._getStreamDisabled) return;

        this._clearGetStreamTimer();
        this._getStreamRequest?.destroy();

        const headers = this._requestHeaders({ Accept: "text/event-stream" });
        if (this._lastEventId !== undefined) headers["Last-Event-ID"] = this._lastEventId;

        const request = this._request(
            "GET",
            headers,
            (response) => this._handleGetResponse(response),
            () => {
                this._getStreamRequest = null;
                this._scheduleGetStream();
            }
        );

        this._getStreamRequest = request;
        request.end();
    }

    private _handleGetResponse(response: IncomingMessage): void {
        const status = response.statusCode ?? 0;
        this._getStreamRequest = null;

        if (status === 404 && this._sessionId) {
            response.resume();
            this._expireSession();
            return;
        }

        // 405 is the documented way of saying "no SSE at this endpoint"; any
        // other client error will not fix itself either, so stop retrying.
        if (status >= 400 && status < 500) {
            this._getStreamDisabled = true;
            response.resume();
            return;
        }

        if (status >= 500) {
            response.resume();
            this._scheduleGetStream();
            return;
        }

        this._captureSession(response);
        this._consumeSse(response, () => this._scheduleGetStream());
    }

    private _scheduleGetStream(): void {
        if (!this._open || !this._enableGetStream || this._getStreamDisabled) return;
        if (this._getStreamRequest || this._getStreamTimer) return;

        this._getStreamTimer = setTimeout(() => {
            this._getStreamTimer = null;
            this._openGetStream();
        }, this._reconnectDelayMs);
        unrefTimer(this._getStreamTimer);
    }

    private _clearGetStreamTimer(): void {
        if (this._getStreamTimer === null) return;
        clearTimeout(this._getStreamTimer);
        this._getStreamTimer = null;
    }

    // -------------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------------

    private _captureSession(response: IncomingMessage): void {
        const rawSessionId = response.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
        if (!sessionId || sessionId === this._sessionId) return;

        const hadSession = this._sessionId !== null;
        this._sessionId = sessionId;

        if (hadSession) {
            // Event ids are unique within a session, so a new session voids the
            // cursor and any stream opened against the previous one.
            this._lastEventId = undefined;
            this._getStreamRequest?.destroy();
            this._getStreamRequest = null;
            this._scheduleGetStream();
        }
    }

    /**
     * Handles a session the server has terminated. Reported as a close so the
     * owning client re-runs `initialize` without a session id, which is exactly
     * what the spec asks of a client on HTTP 404.
     */
    private _expireSession(): void {
        if (!this._open) return;
        const error = new Error("Streamable HTTP session expired (HTTP 404)");
        this._teardown();
        this.onError?.(error);
        this.onClose?.();
    }

    /** Best-effort `DELETE` so the server can release the session immediately. */
    private _terminateSession(): void {
        if (!this._terminateSessionOnClose || !this._sessionId) return;

        const request = makeRequest(this._url, { method: "DELETE", headers: this._requestHeaders({}) }, (response) => response.resume());
        request.on("error", () => {
            /* best effort — the session expires on its own anyway */
        });
        // Do not let a slow teardown hold the process open.
        request.on("socket", (socket: Socket) => socket.unref());
        request.end();
    }

    /** Drops every stream and resets session state, without notifying. */
    private _teardown(): void {
        this._open = false;
        this._clearGetStreamTimer();

        this._getStreamRequest?.destroy();
        this._getStreamRequest = null;

        for (const response of this._responses) response.destroy();
        this._responses.clear();
        for (const request of this._requests) request.destroy();
        this._requests.clear();

        this._sessionId = null;
        this._lastEventId = undefined;
        this._reconnectDelayMs = this._baseReconnectDelayMs;
    }
}
