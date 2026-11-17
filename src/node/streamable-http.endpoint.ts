import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IMessageTransport } from "../interfaces";
import { isProtocolVersionSupported, MCP_ERROR_CODES, MCP_META, MCP_STATELESS_PROTOCOL_VERSIONS } from "../mcp.protocol";
import {
    bearerToken,
    buildChallengeHeader,
    buildProtectedResourceMetadata,
    McpAuthError,
    scopesOf,
    type IMcpPrincipal,
    type IProtectedResourceMetadata,
    type ITokenValidator,
} from "../mcp.auth";
import { HttpSessionTransport } from "./streamable-http.session";
import { decodeMcpHeaderValue, mcpNameOf, StatelessRequestTransport } from "./streamable-http.stateless";

/**
 * Whatever serves one session, seen by the endpoint.
 *
 * Deliberately narrower than {@link IMcpServer}: the endpoint runs the HTTP and
 * session state machine and needs nothing beyond a way to start and stop the
 * thing on the other end of the transport. An `IMcpServer` satisfies it, and so
 * does a relay that forwards the session's frames somewhere else entirely ,
 * which is what lets a broker reuse this class instead of reimplementing it.
 */
export interface IMcpSessionHandle {
    start(): void | Promise<void>;
    stop(): void | Promise<void>;
}

/**
 * Builds whatever will serve one session.
 *
 * The transport is supplied rather than chosen: the endpoint owns the HTTP
 * exchange and hands it over. Behaviors are normally shared across sessions,
 * since they point at the application's own state; only the server routing them
 * is per-session, because a negotiated revision and a resolved grammar belong to
 * one client and not to the next.
 */
export type McpServerFactory = (transport: IMessageTransport, sessionId: string, principal?: IMcpPrincipal) => IMcpSessionHandle | Promise<IMcpSessionHandle>;

/**
 * Turns this endpoint into an OAuth 2.1 protected resource.
 *
 * Supplying it makes every request carry a valid bearer token, and makes the
 * endpoint answer the `401` and `403` challenges the spec defines. Omitting it
 * leaves the endpoint unauthenticated, which is only appropriate behind a
 * trusted boundary.
 */
export interface IStreamableHttpAuthOptions {
    /**
     * Canonical URI identifying this endpoint, per RFC 8707. Tokens must name it
     * in their audience, which is what stops a token issued for another service
     * from being replayed here.
     */
    resource: string;

    /** Verifies a token against {@link resource}. */
    validator: ITokenValidator;

    /** Authorization servers advertised in the metadata document. At least one. */
    authorizationServers: readonly string[];

    /** Absolute URL where the metadata document is served, advertised in challenges. */
    metadataUrl: string;

    /** Scopes advertised as understood by this resource. */
    scopesSupported?: readonly string[];

    /** Scopes a caller must hold. A token missing any of them gets `403`. */
    requiredScopes?: readonly string[];
}

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

    /**
     * Stateless revisions (2026-07-28 and later) served alongside the
     * sessions: a POST without `Mcp-Session-Id` whose request carries its
     * revision in `_meta` is served by a server built for that one request.
     * `[]` turns stateless serving off.
     * @default MCP_STATELESS_PROTOCOL_VERSIONS
     */
    statelessProtocolVersions?: readonly string[];

    /** Session id generator. @default `randomUUID` */
    sessionIdFactory?: () => string;

    /**
     * Drop a session after this many milliseconds without a request.
     * Omit to keep sessions until they are deleted or the endpoint closes.
     */
    idleTimeoutMs?: number;

    /** Protects the endpoint with OAuth 2.1. Omit to leave it open. */
    auth?: IStreamableHttpAuthOptions;
}

interface ISession {
    readonly id: string;
    readonly transport: HttpSessionTransport;
    readonly server: IMcpSessionHandle;
    lastSeen: number;

    /**
     * The caller behind the most recent request on this session.
     *
     * Refreshed on every request rather than fixed at creation: a long-lived
     * session outlives its token, and whoever inspects frames needs the identity
     * that presented the current one.
     */
    principal?: IMcpPrincipal;
}

/**
 * The server half of the MCP Streamable HTTP transport, as a request handler.
 *
 * It deliberately opens no socket. You mount {@link handleRequest} on whatever
 * already serves HTTP (`node:http`, Express, Fastify) because listening,
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
    /** Servers built for one stateless request each, until it is answered. */
    private readonly _exchanges = new Set<{ readonly transport: StatelessRequestTransport; readonly server: IMcpSessionHandle }>();

    constructor(options: IStreamableHttpEndpointOptions) {
        this._options = options;
    }

    /** Number of live sessions. */
    get sessionCount(): number {
        return this._sessions.size;
    }

    /**
     * The Protected Resource Metadata document for this endpoint, or
     * `undefined` when it is not protected.
     *
     * Serve it yourself at {@link IStreamableHttpAuthOptions.metadataUrl} ,
     * routing stays with your application, and the document must be reachable
     * **unauthenticated**, since a client fetches it precisely because it has no
     * token yet.
     */
    protectedResourceMetadata(): IProtectedResourceMetadata | undefined {
        const auth = this._options.auth;
        if (!auth) return undefined;
        return buildProtectedResourceMetadata({
            resource: auth.resource,
            authorizationServers: auth.authorizationServers,
            scopesSupported: auth.scopesSupported,
        });
    }

    /** Handles one HTTP request. Never throws: every failure becomes a status code. */
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            // A request with no Origin cannot come from a browser, so it is not
            // the header check's business and passes straight through.
            const origin = header(req, "origin");
            if (origin !== undefined && !this._originAllowed(origin)) {
                return respond(res, 403, "invalid_origin", this._originRefusedMessage(origin));
            }

            const version = header(req, "mcp-protocol-version");
            if (version !== undefined && !isProtocolVersionSupported(version, this._options.protocolVersions) && !this._statelessVersions().includes(version)) {
                return respond(res, 400, "unsupported_protocol_version", `Unsupported MCP-Protocol-Version: ${version}`);
            }

            let principal: IMcpPrincipal | undefined;
            try {
                principal = await this._authenticate(req);
            } catch (error) {
                return this._writeChallenge(res, error);
            }

            this._evictIdle();

            switch (req.method) {
                case "POST":
                    return await this._handlePost(req, res, principal);
                case "GET":
                    return this._handleGet(req, res, principal);
                case "DELETE":
                    return this._handleDelete(req, res, principal);
                default:
                    res.setHeader("Allow", "GET, POST, DELETE");
                    return respond(res, 405, "method_not_allowed", `Unsupported method: ${req.method ?? "?"}`);
            }
        } catch (error) {
            respond(res, 500, "internal_error", error instanceof Error ? error.message : "Internal error");
        }
    }

    /**
     * Validates the request's bearer token and enforces the required scopes.
     *
     * @throws {McpAuthError} `401` with no usable token, `403` with one that
     *         lacks a required scope.
     */
    private async _authenticate(req: IncomingMessage): Promise<IMcpPrincipal | undefined> {
        const auth = this._options.auth;
        if (!auth) return undefined;

        const token = bearerToken(req.headers["authorization"]);
        if (!token) throw new McpAuthError(401, "invalid_token", "Missing bearer token");

        const claims = await auth.validator.validate(token, auth.resource);
        const scopes = scopesOf(claims);

        const required = auth.requiredScopes ?? [];
        const missing = required.filter((scope) => !scopes.has(scope));
        if (missing.length > 0) {
            throw new McpAuthError(403, "insufficient_scope", `Missing required scope(s): ${missing.join(" ")}`, required.join(" "));
        }

        return { claims, scopes };
    }

    /** Writes an RFC 9728 challenge, always pointing at the metadata document. */
    private _writeChallenge(res: ServerResponse, error: unknown): void {
        const auth = this._options.auth;
        const failure = error instanceof McpAuthError ? error : new McpAuthError(401, "invalid_token", error instanceof Error ? error.message : "Unauthorized");

        res.setHeader(
            "WWW-Authenticate",
            buildChallengeHeader({
                resourceMetadata: auth?.metadataUrl,
                error: failure.code,
                errorDescription: failure.description,
                scope: failure.scope,
            })
        );
        respond(res, failure.status, failure.code, failure.description ?? failure.code);
    }

    /** Terminates every session and releases their servers. */
    async closeAll(): Promise<void> {
        // A stateless server answers its open listens as it stops.
        for (const exchange of [...this._exchanges]) await exchange.server.stop();
        this._exchanges.clear();
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

    private async _handlePost(req: IncomingMessage, res: ServerResponse, principal?: IMcpPrincipal): Promise<void> {
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

        // A request carrying its own revision, outside any session: 2026-07-28.
        if (!sessionId && method !== "initialize" && this._statelessVersions().length > 0 && isStatelessFrame(frame)) {
            return this._handleStateless(req, res, frame as IStatelessFrame, body, principal);
        }

        // `initialize` is the one request that arrives without a session, and the
        // one whose response carries the session id back.
        if (method === "initialize" && !sessionId) {
            const session = await this._createSession(principal);
            res.setHeader("Mcp-Session-Id", session.id);
            return this._feed(session, body, res);
        }

        const session = this._resolve(sessionId, res);
        if (!session) return;
        session.principal = principal;
        return this._feed(session, body, res);
    }

    private _statelessVersions(): readonly string[] {
        return this._options.statelessProtocolVersions ?? MCP_STATELESS_PROTOCOL_VERSIONS;
    }

    /**
     * Serves one stateless request (2026-07-28): checks the headers against
     * the body, builds a server for this request only, and keeps the exchange
     * open until it is answered. A listen stays open until the client closes
     * the stream, which cancels it.
     */
    private async _handleStateless(req: IncomingMessage, res: ServerResponse, frame: IStatelessFrame, body: string, principal?: IMcpPrincipal): Promise<void> {
        const id = frame.id;
        const meta = frame.params._meta;
        const requested = meta[MCP_META.protocolVersion];
        const refuse = (code: number, message: string, data?: unknown) => {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }));
        };

        const version = header(req, "mcp-protocol-version");
        if (version === undefined || version !== requested) {
            return refuse(
                MCP_ERROR_CODES.headerMismatch,
                `MCP-Protocol-Version header (${version ?? "missing"}) must equal params._meta["${MCP_META.protocolVersion}"] (${String(requested)})`
            );
        }
        if (typeof requested !== "string" || !this._statelessVersions().includes(requested)) {
            return refuse(MCP_ERROR_CODES.unsupportedProtocolVersion, `Unsupported protocol version: ${String(requested)}`, {
                supported: [...this._statelessVersions()],
                requested: String(requested),
            });
        }
        if (typeof meta[MCP_META.clientCapabilities] !== "object" || meta[MCP_META.clientCapabilities] === null) {
            return refuse(-32602, `Missing required params._meta["${MCP_META.clientCapabilities}"]`);
        }
        const declaredMethod = header(req, "mcp-method");
        if (declaredMethod !== frame.method) {
            return refuse(MCP_ERROR_CODES.headerMismatch, `Mcp-Method header (${declaredMethod ?? "missing"}) must equal the request method (${frame.method})`);
        }
        const expectedName = mcpNameOf(frame.method, frame.params);
        if (expectedName !== undefined) {
            const raw = header(req, "mcp-name");
            if (raw === undefined || decodeMcpHeaderValue(raw) !== expectedName) {
                return refuse(MCP_ERROR_CODES.headerMismatch, `Mcp-Name header must carry "${expectedName}" for ${frame.method}`);
            }
        }

        // 2026-07-28 defines no client-to-server notification over HTTP: acknowledge and drop.
        if (id === undefined) {
            res.writeHead(202).end();
            return;
        }

        // The transport reports its answer before the server exists to be named: hold it by reference.
        const holder: { exchange?: { readonly transport: StatelessRequestTransport; readonly server: IMcpSessionHandle } } = {};
        const transport = new StatelessRequestTransport(res, id, () => {
            const exchange = holder.exchange;
            if (!exchange) return;
            this._exchanges.delete(exchange);
            void exchange.server.stop();
        });
        const server = await this._options.createServer(transport, `stateless:${(this._options.sessionIdFactory ?? randomUUID)()}`, principal);
        holder.exchange = { transport, server };
        this._exchanges.add(holder.exchange);
        await server.start();

        // The client closing its end cancels the request (2026-07-28: no
        // notifications/cancelled over HTTP); the server then stops.
        res.on("close", () => {
            if (!transport.isOpen) return;
            transport.deliver(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "stream closed by the client" } }));
            transport.close();
        });
        transport.deliver(body);
    }

    private _handleGet(req: IncomingMessage, res: ServerResponse, principal?: IMcpPrincipal): void {
        const session = this._resolve(header(req, "mcp-session-id"), res);
        if (!session) return;
        session.principal = principal;

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

    private _handleDelete(req: IncomingMessage, res: ServerResponse, _principal?: IMcpPrincipal): void {
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

    private async _createSession(principal?: IMcpPrincipal): Promise<ISession> {
        const id = (this._options.sessionIdFactory ?? randomUUID)();
        const transport = new HttpSessionTransport(id);
        const server = await this._options.createServer(transport, id, principal);
        await server.start();

        const session: ISession = { id, transport, server, lastSeen: Date.now(), principal };
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

    private _originAllowed(origin: string): boolean {
        const allowed = this._options.allowedOrigins;
        if (typeof allowed === "function") return allowed(origin);
        return allowed?.includes(origin) ?? false;
    }

    /**
     * Builds the `403` body for a refused origin.
     *
     * The refused value is echoed verbatim, because the mismatch is almost
     * always invisible from the outside: a scheme, a port or a trailing slash.
     * `respond` serializes through `JSON.stringify` into
     * `application/json; charset=utf-8`, so the header value cannot break out
     * of the body. The unconfigured case gets its own sentence: an empty
     * `allowedOrigins` is a closed door by design, not a typo, and the reader
     * needs to know which of the two situations they are in.
     */
    private _originRefusedMessage(origin: string): string {
        const allowed = this._options.allowedOrigins;
        if (allowed === undefined) {
            return `Origin "${origin}" is not allowed: this endpoint has no allowedOrigins configured, so every browser Origin is refused. Set allowedOrigins to the exact origins that may reach it.`;
        }
        if (typeof allowed === "function") {
            return `Origin "${origin}" is not allowed by this endpoint's allowedOrigins predicate.`;
        }
        const listed = allowed.length === 0 ? "the allowedOrigins list is empty" : `allowedOrigins holds ${allowed.map((o) => `"${o}"`).join(", ")}`;
        return `Origin "${origin}" is not allowed: ${listed}. Origins are compared verbatim, so scheme, host, port and the absence of a trailing slash must all match.`;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A request written for a stateless revision: its revision is in `params._meta`. */
interface IStatelessFrame {
    readonly id?: string | number;
    readonly method: string;
    readonly params: { readonly _meta: Record<string, unknown> } & Record<string, unknown>;
}

function isStatelessFrame(frame: unknown): boolean {
    const record = frame as { method?: unknown; params?: { _meta?: unknown } };
    const meta = record.params?._meta;
    return typeof record.method === "string" && typeof meta === "object" && meta !== null && !Array.isArray(meta) && MCP_META.protocolVersion in meta;
}

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
