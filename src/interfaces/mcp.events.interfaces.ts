/**
 * Types for the Events extension, `io.modelcontextprotocol/events` (SEP-3415,
 * read at PR head 4165cc2e, marked "Accepted" while the PR was still open):
 * a server publishes named event streams a client polls or streams, from a
 * cursor, without holding protocol state.
 *
 * Defined for the stateless revisions only (2026-07-28 and later).
 */

/** The extension identifier. */
export const MCP_EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** The `subscriptions/listen` flag that turns on `notifications/events/list_changed`. */
export const MCP_EVENTS_LIST_CHANGED_FLAG = "eventsListChanged";

/** Error codes of the extension (provisional numbers in the SEP). */
export const MCP_EVENTS_ERROR_CODES = Object.freeze({
    notFound: -32023,
    forbidden: -32024,
    resourceExhausted: -32025,
    unsupported: -32026,
    callbackEndpointError: -32027,
} as const);

/** How occurrences of an event can reach a client. */
export type McpEventDelivery = "poll" | "push" | "webhook";

/** One event a server publishes, as `events/list` describes it. */
export interface McpEventDescriptor {
    name: string;
    description?: string;
    /** Non-empty. */
    delivery: McpEventDelivery[];
    /** JSON Schema of the `arguments` a client filters with. Should evolve only additively. */
    inputSchema: object;
    /** JSON Schema of each occurrence's `data`. Should evolve only additively. */
    payloadSchema: object;
    _meta?: { [key: string]: unknown };
}

/** One occurrence of an event. */
export interface McpEventOccurrence {
    /** Unique per occurrence: a client deduplicates on it. */
    eventId: string;
    name: string;
    /** ISO 8601. */
    timestamp: string;
    data: { [key: string]: unknown };
    /** Push and webhook only: where to resume after this occurrence. `null`: do not persist. */
    cursor?: string | null;
    _meta?: { [key: string]: unknown };
}

/** `events/poll` result, besides `resultType`. */
export interface McpEventsPollResult {
    events: McpEventOccurrence[];
    /** Where to poll from next time. */
    cursor: string;
    /** Occurrences were lost between the requested cursor and the first returned. */
    truncated: boolean;
    /** More are ready: poll again at once. */
    hasMore: boolean;
    /** The server's suggestion for the next poll. */
    nextPollMs: number;
}

/** Options of a poll or a stream. */
export interface McpEventsReadOptions {
    /** Leave out occurrences older than this. */
    maxAgeMs?: number;
    /** At most this many occurrences (poll). */
    maxEvents?: number;
}
