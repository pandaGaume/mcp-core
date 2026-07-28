import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IMcpServer, IMessageTransport } from "../interfaces";
import { isProtocolVersionSupported } from "../mcp.protocol";
import { HttpSessionTransport } from "./streamable-http.session";

/**
 * Builds the MCP server that will serve one session.
 *
 * The transport is supplied rather than chosen: the endpoint owns the HTTP
 * exchange and hands it over. Behaviors are normally shared across sessions,
 * since they point at the application's own state; only the server routing them
 * is per-session, because a negotiated revision and a resolved grammar belong to
 * one client and not to the next.
 */
export type McpServerFactory = (transport: IMessageTransport, sessionId: string) => IMcpServer | Promise<IMcpServer>;

/** Options for {@link StreamableHttpEndpoint}. */
export interface IStreamableHttpEndpointOptions {
    /** Builds the per-session MCP server. */
    createServer: McpServerFactory;

    /**
     * Origins allowed to reach this endpoint from a browser.
     *
     * The spec requires servers to validate the `Origin` header and answer
     * `403` when it is invalid, because without it any web page can drive a
     * local MCP server through DNS rebinding. A request carrying no `Origin`
     * (any non-browser client) is always allowed; one carrying an origin is
     * refused unless it is listed here, so the default is closed.
     */
    allowedOrigins?: readonly string[] | ((origin: string) => boolean);

    /**
     * Protocol revisions accepted in the `MCP-Protocol-Version` header.
     * A request naming anything else is refused with `400`, as the spec requires.
     * @default every revision this package implements
     */
    protocolVersions?: readonly string[];

    /** Session id generator. @default `randomUUID` */
    sessionIdFactory?: () => string;

    /**
     * Drop a session after this many milliseconds without a request.
     * Omit to keep sessions until they are deleted or the endpoint closes.
     */
    idleTimeoutMs?: number;
}

interface ISession {
    readonly id: string;
    readonly transport: HttpSessionTransport;
    readonly server: IMcpServer;
    lastSeen: number;
}

/**
 * The server half of the MCP Streamable HTTP transport, as a request handler.
 *
 * It deliberately opens no socket. You mount {@link handleRequest} on whatever
 * already serves HTTP — `node:http`, Express, Fastify — because listening,
 * TLS and routing are your application's business, while sessions, framing and
 * the protocol's status codes are the ones nobody should have to reimplement.
 *
 * ```ts
 * const endpoint = new StreamableHttpEndpoint({
 *     createServer: (transport) => new McpServerBuilder().withName("app").withTransport(transport).register(behavior).build(),
 * });
 * createServer((req, res) => void endpoint.handleRequest(req, res)).listen(3000);
 * ```
 *
 * A `POST` carrying a request is answered as `application/json`, which the spec
 * allows in place of an SSE stream and which keeps a single request-response
 * exchange free of stream bookkeeping. Server-initiated messages travel on the
 * standalone `GET` stream.
 */
export class StreamableHttpEndpoint {
    private readonly _options: IStreamableHttpEndpointOptions;
    private readonly _sessions = new Map<string, ISession>();

    constructor(options: IStreamableHttpEndpointOptions) {
        this._options = options;
    }

    /** Number of live sessions. */
    get sessionCount(): number {
        return this._sessions.size;
    }

    /** Handles one HTTP request. Never throws: every failure becomes a status code. */
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            if (!this._originAllowed(req)) return respond(res, 403, "invalid_origin", "Origin not allowed");

            const version = header(req, "mcp-protocol-version");
            if (version !== undefined && !isProtocolVersionSupported(version, this._options.protocolVersions)) {
                return respond(res, 400, "unsupported_protocol_version", `Unsupported MCP-Protocol-Version: ${version}`);
            }

            this._evictIdle();

            switch (req.method) {
                case "POST":
                    return await this._handlePost(req, res);
                case "GET":
                    return this._handleGet(req, res);
                case "DELETE":
                    return this._handleDelete(req, res);
                default:
                    res.setHeader("Allow", "GET, POST, DELETE");
                    return respond(res, 405, "method_not_allowed", `Unsupported method: ${req.method ?? "?"}`);
            }
        } catch (error) {
            respond(res, 500, "internal_error", error instanceof Error ? error.message : "Internal error");
        }
    }

    /** Terminates every session and releases their servers. */
    async closeAll(): Promise<void> {
        const sessions = [...this._sessions.values()];
        this._sessions.clear();
        for (const session of sessions) {
            session.transport.close();
            await session.server.stop();
        }
    }

    // -------------------------------------------------------------------------
    // Methods
    // -------------------------------------------------------------------------

    private async _handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readBody(req);
        let frame: unknown;
        try {
            frame = JSON.parse(body);
        } catch {
            return respond(res, 400, "parse_error", "Body is not valid JSON");
        }

        // Batching was removed from MCP in revision 2025-06-18.
        if (Array.isArray(frame)) return respond(res, 400, "invalid_request", "JSON-RPC batching is not supported");
        if (typeof frame !== "object" || frame === null) return respond(res, 400, "invalid_request", "Body is not a JSON-RPC message");

        const method = (frame as { method?: unknown }).method;
        const sessionId = header(req, "mcp-session-id");

        // `initialize` is the one request that arrives without a session, and the
        // one whose response carries the session id back.
        if (method === "initialize" && !sessionId) {
            const session = await this._createSession();
            res.setHeader("Mcp-Session-Id", session.id);
            return this._feed(session, body, res);
        }

        const session = this._resolve(sessionId, res);
        if (!session) return;
        return this._feed(session, body, res);
    }

    private _handleGet(req: IncomingMessage, res: ServerResponse): void {
        const session = this._resolve(header(req, "mcp-session-id"), res);
        if (!session) return;

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Mcp-Session-Id": session.id,
        });
        // Prime the stream so the client sees headers immediately.
        res.write(": open\n\n");

        session.transport.attachStream(res);
        req.on("close", () => session.transport.detachStream(res));
    }

    private _handleDelete(req: IncomingMessage, res: ServerResponse): void {
        const session = this._resolve(header(req, "mcp-session-id"), res);
        if (!session) return;

        this._sessions.delete(session.id);
        session.transport.close();
        void session.server.stop();
        res.writeHead(204).end();
    }

    // -------------------------------------------------------------------------
    // Sessions
    // -------------------------------------------------------------------------

    private async _createSession(): Promise<ISession> {
        const id = (this._options.sessionIdFactory ?? randomUUID)();
        const transport = new HttpSessionTransport(id);
        const server = await this._options.createServer(transport, id);
        await server.start();

        const session: ISession = { id, transport, server, lastSeen: Date.now() };
        this._sessions.set(id, session);
        return session;
    }

    /**
     * Resolves the session named by the request, writing the matching failure
     * and returning `undefined` when it cannot.
     *
     * A terminated session must answer `404` and not `400`: that is the signal
     * the spec defines for a client to start a fresh `initialize`.
     */
    private _resolve(sessionId: string | undefined, res: ServerResponse): ISession | undefined {
        if (!sessionId) {
            respond(res, 400, "missing_session", "Mcp-Session-Id header is required");
            return undefined;
        }
        const session = this._sessions.get(sessionId);
        if (!session) {
            respond(res, 404, "unknown_session", "Session not found or terminated");
            return undefined;
        }
        session.lastSeen = Date.now();
        return session;
    }

    /** Hands a frame to the session, answering `202` when nothing will reply. */
    private _feed(session: ISession, frame: string, res: ServerResponse): void {
        const awaited = session.transport.deliver(frame, res);
        if (!awaited) res.writeHead(202).end();
    }

    private _evictIdle(): void {
        const ttl = this._options.idleTimeoutMs;
        if (!ttl) return;

        const cutoff = Date.now() - ttl;
        for (const session of [...this._sessions.values()]) {
            if (session.lastSeen >= cutoff) continue;
            this._sessions.delete(session.id);
            session.transport.close();
            void session.server.stop();
        }
    }

    private _originAllowed(req: IncomingMessage): boolean {
        const origin = header(req, "origin");
        if (origin === undefined) return true; // not a browser

        const allowed = this._options.allowedOrigins;
        if (typeof allowed === "function") return allowed(origin);
        return allowed?.includes(origin) ?? false;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

function respond(res: ServerResponse, status: number, error: string, description: string): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error, error_description: description }));
}
