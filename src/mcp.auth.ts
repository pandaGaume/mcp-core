/**
 * The OAuth 2.1 resource-server side of MCP, reduced to what the specification
 * actually defines and nothing more.
 *
 * MCP does not define an authorization server, a token format or a permission
 * model. It defines how a **resource server** advertises where to get a token
 * (RFC 9728), how it challenges a caller that has none or the wrong one
 * (RFC 6750), and that it must bind tokens to itself by audience (RFC 8707).
 * That is the whole surface, and all of it is string and object shaping.
 *
 * So this module is isomorphic and dependency-free on purpose. Validating a JWT
 * needs a crypto library and belongs to the application, behind
 * {@link ITokenValidator}. Reading an HTTP request and writing a status belongs
 * to whatever terminates HTTP. Both would have pinned this to one runtime, and
 * the same pieces are needed in reverse by a client: it parses the challenge
 * this builds, and reads the metadata document this emits.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization MCP Authorization}
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The claims a validated access token carries.
 *
 * Only the fields MCP reasons about are named; a validator is free to surface
 * anything else its authorization server issues.
 */
export interface IAccessTokenClaims {
    /** Subject: who the token was issued for. */
    sub?: string;

    /** Audience: which resource the token is valid at. MCP requires this to be checked. */
    aud?: string | string[];

    /** Issuer. */
    iss?: string;

    /** Space-delimited scopes, per OAuth 2.1. */
    scope?: string;

    /** Expiry, as a UNIX timestamp in seconds. */
    exp?: number;

    [claim: string]: unknown;
}

/** A caller whose token has been validated. */
export interface IMcpPrincipal {
    /** The validated claims. */
    claims: IAccessTokenClaims;

    /** The token's scopes, split out of {@link IAccessTokenClaims.scope}. */
    scopes: ReadonlySet<string>;
}

/**
 * Validates a bearer token for a given resource.
 *
 * The single seam between MCP's authorization requirements and however an
 * application actually verifies tokens: a JWKS-backed JWT check, an
 * introspection call, a shared secret in a test. Implementations **must** verify
 * that `resource` is among the token's audience, since a resource server
 * accepting a token issued for someone else is the vulnerability the spec is
 * most explicit about.
 *
 * @throws {McpAuthError} when the token is missing, malformed, expired, or not
 *         issued for this resource.
 */
export interface ITokenValidator {
    validate(token: string, resource: string): Promise<IAccessTokenClaims>;
}

/** Splits the space-delimited `scope` claim into a set. */
export function scopesOf(claims: IAccessTokenClaims): ReadonlySet<string> {
    const raw = typeof claims.scope === "string" ? claims.scope : "";
    return new Set(raw.split(/\s+/).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Errors and challenges
// ---------------------------------------------------------------------------

/** The OAuth error codes MCP uses in a challenge. */
export type McpAuthErrorCode = "invalid_token" | "insufficient_scope" | "invalid_request";

/**
 * An authorization failure, carrying everything a challenge needs.
 *
 * The status is part of the contract rather than a detail: `401` means "you have
 * no usable token, go get one", `403` means "your token is real but does not
 * carry enough", and a client reacts differently to each.
 */
export class McpAuthError extends Error {
    constructor(
        readonly status: 400 | 401 | 403,
        readonly code: McpAuthErrorCode,
        readonly description?: string,
        /** Scopes the caller needs, echoed back so it can ask for exactly those. */
        readonly scope?: string
    ) {
        super(description ?? code);
        this.name = "McpAuthError";
    }
}

/** The parts of an RFC 9728 §5.1 `WWW-Authenticate` challenge. */
export interface IMcpAuthChallenge {
    /** Absolute URL of the Protected Resource Metadata document. */
    resourceMetadata?: string;

    /** OAuth error code. */
    error?: string;

    /** Human-readable explanation. */
    errorDescription?: string;

    /** Space-delimited scopes required to satisfy the request. */
    scope?: string;
}

/** Strips characters that would break out of an HTTP header value. */
function headerSafe(value: string): string {
    return value.replace(/[\r\n"]/g, " ").trim();
}

/**
 * Builds the `WWW-Authenticate` value for a challenge.
 *
 * `scope` is worth including on a `403`: it is what lets a client ask for
 * exactly the missing permissions instead of re-requesting everything, which is
 * the incremental consent flow added in revision 2025-11-25.
 */
export function buildChallengeHeader(challenge: IMcpAuthChallenge): string {
    const params: string[] = [];
    if (challenge.resourceMetadata) params.push(`resource_metadata="${headerSafe(challenge.resourceMetadata)}"`);
    if (challenge.error) params.push(`error="${headerSafe(challenge.error)}"`);
    if (challenge.errorDescription) params.push(`error_description="${headerSafe(challenge.errorDescription)}"`);
    if (challenge.scope) params.push(`scope="${headerSafe(challenge.scope)}"`);
    return params.length > 0 ? `Bearer ${params.join(", ")}` : "Bearer";
}

/**
 * Parses a `WWW-Authenticate` value back into its parts — the client's half.
 *
 * Returns `undefined` for a scheme other than Bearer. Unknown parameters are
 * ignored rather than rejected, since the header is extensible.
 */
export function parseChallengeHeader(value: string | undefined | null): IMcpAuthChallenge | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!/^Bearer\b/i.test(trimmed)) return undefined;

    const challenge: IMcpAuthChallenge = {};
    const params = trimmed.slice("Bearer".length);
    const pattern = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;

    for (let match = pattern.exec(params); match !== null; match = pattern.exec(params)) {
        const key = match[1].toLowerCase();
        const raw = match[2] ?? match[3] ?? "";
        if (key === "resource_metadata") challenge.resourceMetadata = raw;
        else if (key === "error") challenge.error = raw;
        else if (key === "error_description") challenge.errorDescription = raw;
        else if (key === "scope") challenge.scope = raw;
    }

    return challenge;
}

/** Extracts the token from an `Authorization` header value, or `null`. */
export function bearerToken(header: string | string[] | undefined | null): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Protected Resource Metadata (RFC 9728)
// ---------------------------------------------------------------------------

/**
 * The document an MCP server must publish so a client can find its authorization
 * server. Required by the spec: without it a client has nowhere to start.
 */
export interface IProtectedResourceMetadata {
    /** Canonical URI of this resource, matching the token audience. */
    resource: string;

    /** Authorization servers that issue tokens for it. At least one. */
    authorization_servers: string[];

    /** How a token may be presented. MCP only uses the header. */
    bearer_methods_supported: string[];

    /** Scopes this resource understands, advertised to guide a first request. */
    scopes_supported?: string[];

    /** Human-facing documentation. */
    resource_documentation?: string;
}

/** Builds the metadata document. */
export function buildProtectedResourceMetadata(options: {
    resource: string;
    authorizationServers: readonly string[];
    scopesSupported?: readonly string[];
    documentation?: string;
}): IProtectedResourceMetadata {
    const metadata: IProtectedResourceMetadata = {
        resource: options.resource,
        authorization_servers: [...options.authorizationServers],
        bearer_methods_supported: ["header"],
    };
    if (options.scopesSupported?.length) metadata.scopes_supported = [...options.scopesSupported];
    if (options.documentation) metadata.resource_documentation = options.documentation;
    return metadata;
}

/** Well-known prefix under which Protected Resource Metadata is served. */
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * The well-known path serving the metadata for a resource at `resourcePath`.
 *
 * RFC 9728 inserts the resource's path after the well-known segment, so an MCP
 * endpoint at `/mcp` publishes at `/.well-known/oauth-protected-resource/mcp`.
 * A resource at the root publishes at the prefix itself.
 */
export function protectedResourceMetadataPath(resourcePath = ""): string {
    const path = resourcePath.replace(/^\/+|\/+$/g, "");
    return path ? `${PROTECTED_RESOURCE_METADATA_PREFIX}/${path}` : PROTECTED_RESOURCE_METADATA_PREFIX;
}

/**
 * Normalizes a URI into the canonical form RFC 8707 expects as a `resource`.
 *
 * Lowercases scheme and host, drops any fragment, and removes a trailing slash,
 * which is what makes an audience comparison reliable on both ends. Throws on a
 * URI that cannot serve as a resource identifier.
 */
export function canonicalResourceUri(uri: string): string {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`canonicalResourceUri: unsupported scheme "${url.protocol}"`);
    }
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    const serialized = url.toString();
    return serialized.endsWith("/") && url.pathname === "/" ? serialized.slice(0, -1) : serialized.replace(/\/$/, "");
}
