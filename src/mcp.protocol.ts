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

/** The newest MCP revision this package implements. */
export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";

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
 *   SHOULD be the latest one — hence `supported[0]`.
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
 * negotiateProtocolVersion("2025-06-18");            // "2025-06-18" — honoured
 * negotiateProtocolVersion("1999-01-01");            // "2025-11-25" — latest fallback
 * negotiateProtocolVersion(undefined);               // "2025-11-25" — latest fallback
 * negotiateProtocolVersion("2025-11-25", ["2024-11-05"]); // "2024-11-05" — narrowed server
 * ```
 */
export function negotiateProtocolVersion(requested: string | undefined, supported: readonly string[] = MCP_SUPPORTED_PROTOCOL_VERSIONS): string {
    if (isProtocolVersionSupported(requested, supported)) return requested as string;
    return supported[0] ?? MCP_LATEST_PROTOCOL_VERSION;
}
