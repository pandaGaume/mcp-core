/**
 * MCP protocol revision constants and version negotiation.
 *
 * The Model Context Protocol is versioned by date string (e.g. `"2025-11-25"`),
 * not by semver. During the `initialize` handshake the client sends the newest
 * revision it supports and the server answers with the revision it will use for
 * the session.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle MCP Lifecycle}
 */

/**
 * The newest MCP revision this package negotiates through `initialize`.
 *
 * Revisions from 2026-07-28 on have no handshake: see
 * {@link MCP_STATELESS_PROTOCOL_VERSIONS}.
 */
export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";

/**
 * The newest stateless MCP revision this package implements: no `initialize`,
 * every request carries its revision and the client's capabilities in
 * `params._meta`, and `server/discover` replaces the handshake.
 */
export const MCP_LATEST_STATELESS_PROTOCOL_VERSION = "2026-07-28";

/** Every stateless revision this package can speak, newest first. */
export const MCP_STATELESS_PROTOCOL_VERSIONS: readonly string[] = [MCP_LATEST_STATELESS_PROTOCOL_VERSION] as const;

/** Whether `version` is a stateless revision (2026-07-28 or later) this package, or a narrowed set, speaks. */
export function isStatelessProtocolVersion(version: string | undefined, supported: readonly string[] = MCP_STATELESS_PROTOCOL_VERSIONS): boolean {
    return version !== undefined && supported.includes(version);
}

/** Reserved `_meta` keys of the stateless revisions. */
export const MCP_META = Object.freeze({
    /** Request, required: the revision the request is written in. */
    protocolVersion: "io.modelcontextprotocol/protocolVersion",
    /** Request, required: what the client supports, for this request only. */
    clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
    /** Request, recommended: who the client is. */
    clientInfo: "io.modelcontextprotocol/clientInfo",
    /** Request, deprecated: the lowest `notifications/message` level wanted for this request. */
    logLevel: "io.modelcontextprotocol/logLevel",
    /** Result, recommended: who the server is. */
    serverInfo: "io.modelcontextprotocol/serverInfo",
    /** Notification and `subscriptions/listen` result: the listen request it belongs to. */
    subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const);

/** Error codes the MCP specification reserves (range -32020 to -32099). */
export const MCP_ERROR_CODES = Object.freeze({
    /** Streamable HTTP: a required header is missing, malformed, or contradicts the body. */
    headerMismatch: -32020,
    /** The request needs a client capability the request did not declare. */
    missingRequiredClientCapability: -32021,
    /** The request's revision is not one the server speaks. `data: { supported, requested }`. */
    unsupportedProtocolVersion: -32022,
} as const);

/** Requests the stateless revisions add. */
export const MCP_STATELESS_REQUEST_METHODS: readonly string[] = ["server/discover", "subscriptions/listen"] as const;

/** Requests the stateless revisions removed: a stateless request naming one gets `-32601`. */
export const MCP_STATELESS_REMOVED_METHODS: readonly string[] = ["initialize", "ping", "logging/setLevel", "resources/subscribe", "resources/unsubscribe"] as const;

/** Results that carry `ttlMs` and `cacheScope` in the stateless revisions. */
export const MCP_CACHEABLE_METHODS: readonly string[] = ["server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read"] as const;

/**
 * Every MCP revision this package can speak, ordered newest first.
 *
 * Order matters: {@link negotiateProtocolVersion} answers with the first entry
 * when it cannot honour the revision the client asked for, and the spec says
 * that fallback SHOULD be the latest revision the server supports.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/**
 * Tests whether a revision is one this package (or a narrowed set) can speak.
 *
 * @param version   - The revision string to test, e.g. `"2025-06-18"`.
 * @param supported - Optional narrowed set, newest first. Defaults to {@link MCP_SUPPORTED_PROTOCOL_VERSIONS}.
 */
export function isProtocolVersionSupported(version: string | undefined, supported: readonly string[] = MCP_SUPPORTED_PROTOCOL_VERSIONS): boolean {
    return version !== undefined && supported.includes(version);
}

/**
 * Picks the protocol revision to use for a session.
 *
 * Implements the negotiation rule from the MCP lifecycle spec:
 * - If the server supports the revision the client requested, it MUST answer
 *   with that same revision.
 * - Otherwise it MUST answer with another revision it supports, and that
 *   SHOULD be the latest one, hence `supported[0]`.
 *
 * A missing or malformed request version is treated as "unsupported", so the
 * caller still receives a usable revision instead of echoing `undefined`.
 *
 * @param requested - The `protocolVersion` sent in the client's `initialize` params.
 * @param supported - Optional narrowed set, newest first. Defaults to {@link MCP_SUPPORTED_PROTOCOL_VERSIONS}.
 * @returns The revision the server should answer with.
 *
 * @example
 * ```typescript
 * negotiateProtocolVersion("2025-06-18");            // "2025-06-18", honoured
 * negotiateProtocolVersion("1999-01-01");            // "2025-11-25", latest fallback
 * negotiateProtocolVersion(undefined);               // "2025-11-25", latest fallback
 * negotiateProtocolVersion("2025-11-25", ["2024-11-05"]); // "2024-11-05", narrowed server
 * ```
 */
export function negotiateProtocolVersion(requested: string | undefined, supported: readonly string[] = MCP_SUPPORTED_PROTOCOL_VERSIONS): string {
    if (isProtocolVersionSupported(requested, supported)) return requested as string;
    return supported[0] ?? MCP_LATEST_PROTOCOL_VERSION;
}

/**
 * Every request a client may send to a server, per revision, newest first.
 *
 * This is the checklist the server is held to: `tests/spec.coverage.test.ts`
 * sends each one and fails on a `-32601` unless the method is listed in
 * {@link MCP_SERVER_UNSUPPORTED_METHODS} with a reason. A method the spec adds
 * therefore cannot go missing silently again, the way `resources/subscribe`
 * and `prompts/*` did.
 *
 * Methods only a client answers (`sampling/createMessage`, `roots/list`,
 * `elicitation/create`) are not listed: a server never receives them.
 */
export const MCP_SERVER_REQUEST_METHODS: Readonly<Record<string, readonly string[]>> = {
    "2024-11-05": [
        "initialize",
        "ping",
        "resources/list",
        "resources/templates/list",
        "resources/read",
        "resources/subscribe",
        "resources/unsubscribe",
        "prompts/list",
        "prompts/get",
        "tools/list",
        "tools/call",
        "completion/complete",
        "logging/setLevel",
    ],
    "2025-03-26": [],
    "2025-06-18": [],
    // Tasks are experimental in 2025-11-25.
    "2025-11-25": ["tasks/get", "tasks/result", "tasks/list", "tasks/cancel"],
};

/**
 * Notifications a client may send to a server. A server never answers a
 * notification, so "handled" means "not answered": the coverage test checks
 * that nothing, not even an error, goes back.
 */
export const MCP_SERVER_NOTIFICATION_METHODS: readonly string[] = [
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
    "notifications/roots/list_changed",
    "notifications/tasks/status",
];

/**
 * Request methods this package deliberately answers with `-32601`, each with
 * the reason. Empty the entry when the method is implemented; the coverage
 * test fails if an entry here turns out to be handled after all.
 */
export const MCP_SERVER_UNSUPPORTED_METHODS: Readonly<Record<string, string>> = {
    "tasks/get": "task-augmented requests (experimental in 2025-11-25) are not implemented; the server never advertises `tasks`",
    "tasks/result": "see tasks/get",
    "tasks/list": "see tasks/get",
    "tasks/cancel": "see tasks/get",
};

/**
 * The request methods a client may send under `revision`: every method
 * introduced by that revision or an earlier one.
 */
export function serverRequestMethodsFor(revision: string = MCP_LATEST_PROTOCOL_VERSION): string[] {
    const out: string[] = [];
    // The table is keyed oldest first by date, which sorts lexically.
    for (const [introducedIn, methods] of Object.entries(MCP_SERVER_REQUEST_METHODS).sort(([a], [b]) => a.localeCompare(b))) {
        if (introducedIn <= revision) out.push(...methods);
    }
    return out;
}
