import { createEventEmitter } from "../interfaces/eventSource";
import type { IEventEmitter, IEventSource } from "../interfaces/eventSource";
import type { JsonRpcRequest, JsonRpcResponse } from "../interfaces/mcp.jsonrpc.interfaces";
import type { IMcpRequestContext } from "../interfaces/mcp.behavior.interfaces";
import type { IMcpExtensionHost, IMcpServerExtension, McpExtensionHandler } from "../interfaces/mcp.extension.interfaces";
import { MCP_EVENTS_ERROR_CODES, MCP_EVENTS_EXTENSION, MCP_EVENTS_LIST_CHANGED_FLAG } from "../interfaces/mcp.events.interfaces";
import type { McpEventDelivery, McpEventDescriptor, McpEventOccurrence, McpEventsPollResult, McpEventsReadOptions } from "../interfaces/mcp.events.interfaces";
import { MCP_META } from "../mcp.protocol";
import { jsonRpcError, jsonRpcOk } from "../server/jsonrpc.helpers";
import type { McpClient } from "../client/mcp.client";

/** An error an event source raises for the client: a JSON-RPC code, a message, optional data. */
export class McpEventsError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "McpEventsError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The event log: what an application publishes into
// ---------------------------------------------------------------------------

/** One event an application publishes, and how a client's arguments select its occurrences. */
export interface McpEventDefinition {
    readonly name: string;
    readonly description?: string;
    /** @default `["poll", "push"]`. `"webhook"` is not served by {@link McpEventsExtension}. */
    readonly delivery?: McpEventDelivery[];
    /** JSON Schema of the client's `arguments`. @default an object accepting anything */
    readonly inputSchema?: object;
    /** JSON Schema of each occurrence's `data`. @default an object accepting anything */
    readonly payloadSchema?: object;
    /**
     * Whether an occurrence's data matches a client's arguments. Throw an
     * {@link McpEventsError} with `-32602` for arguments that make no sense.
     * @default every occurrence matches
     */
    matches?(args: Readonly<Record<string, unknown>>, data: Readonly<Record<string, unknown>>): boolean;
}

/** An occurrence in the log, with its position. */
interface ILogged {
    readonly seq: number;
    readonly occurrence: McpEventOccurrence;
    readonly at: number;
}

/** What {@link McpEventLog.read} found. */
export interface McpEventLogRead {
    readonly events: readonly { readonly seq: number; readonly occurrence: McpEventOccurrence }[];
    /** Where the read stopped: the cursor to continue from. */
    readonly seq: number;
    readonly truncated: boolean;
    readonly hasMore: boolean;
}

/**
 * A bounded, in-memory log of event occurrences, the source an
 * {@link McpEventsExtension} serves from. An application defines its events
 * and publishes occurrences; clients read them by cursor.
 *
 * Cursors are positions in the log, as decimal strings. A cursor older than
 * what the log still holds reads from the oldest occurrence kept, with
 * `truncated: true`, so a client knows it missed some.
 *
 * ```ts
 * const log = new McpEventLog({ capacity: 10_000 });
 * log.define({ name: "alarm", matches: (args, data) => !args.area || args.area === data.area });
 * log.publish("alarm", { area: "nord", tag: "P-101", state: "HH" });
 * ```
 */
export class McpEventLog {
    private readonly _capacity: number;
    private readonly _now: () => number;
    private readonly _definitions = new Map<string, McpEventDefinition>();
    private readonly _entries: ILogged[] = [];
    private _seq = 0;
    private _counter = 0;
    private readonly _onPublished: IEventEmitter<{ readonly seq: number; readonly occurrence: McpEventOccurrence }> = createEventEmitter();
    private readonly _onListChanged: IEventEmitter<void> = createEventEmitter();

    constructor(options: { readonly capacity?: number; readonly now?: () => number } = {}) {
        this._capacity = Math.max(1, options.capacity ?? 1_000);
        this._now = options.now ?? Date.now;
    }

    /** Fires on each occurrence published. */
    get onPublished(): IEventSource<{ readonly seq: number; readonly occurrence: McpEventOccurrence }> {
        return this._onPublished;
    }

    /** Fires when an event is defined or removed. */
    get onListChanged(): IEventSource<void> {
        return this._onListChanged;
    }

    /** The position of the newest occurrence, `0` before the first. */
    get head(): number {
        return this._seq;
    }

    /** Adds or replaces an event. */
    define(definition: McpEventDefinition): this {
        if (!definition.name) throw new Error("McpEventLog: an event needs a name");
        const delivery = definition.delivery ?? ["poll", "push"];
        if (delivery.length === 0) throw new Error(`McpEventLog: event "${definition.name}" has no delivery mode`);
        this._definitions.set(definition.name, { ...definition, delivery });
        this._onListChanged.emit();
        return this;
    }

    /** Removes an event. Its occurrences stay readable until they age out. */
    undefine(name: string): this {
        if (this._definitions.delete(name)) this._onListChanged.emit();
        return this;
    }

    /** The event named `name`, `undefined` when it is not defined. */
    definition(name: string): McpEventDefinition | undefined {
        return this._definitions.get(name);
    }

    /** Every event, as `events/list` describes it. */
    descriptors(): McpEventDescriptor[] {
        return [...this._definitions.values()].map((definition) => ({
            name: definition.name,
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            delivery: [...(definition.delivery ?? ["poll", "push"])],
            inputSchema: definition.inputSchema ?? { type: "object" },
            payloadSchema: definition.payloadSchema ?? { type: "object" },
        }));
    }

    /** Records one occurrence of `name` and returns it. */
    publish(name: string, data: Record<string, unknown>, options: { readonly eventId?: string; readonly timestamp?: string } = {}): McpEventOccurrence {
        if (!this._definitions.has(name)) throw new Error(`McpEventLog: event "${name}" is not defined`);
        const at = this._now();
        this._seq += 1;
        const occurrence: McpEventOccurrence = {
            eventId: options.eventId ?? `${at.toString(36)}-${(++this._counter).toString(36)}`,
            name,
            timestamp: options.timestamp ?? new Date(at).toISOString(),
            data: { ...data },
        };
        this._entries.push({ seq: this._seq, occurrence, at });
        if (this._entries.length > this._capacity) this._entries.splice(0, this._entries.length - this._capacity);
        this._onPublished.emit({ seq: this._seq, occurrence });
        return occurrence;
    }

    /**
     * Reads the occurrences of `name` matching `args` after position `from`.
     * Throws an {@link McpEventsError} when the event is unknown or the
     * arguments are refused.
     */
    read(name: string, args: Readonly<Record<string, unknown>>, from: number, options: McpEventsReadOptions = {}): McpEventLogRead {
        const definition = this._definitions.get(name);
        if (!definition) throw new McpEventsError(MCP_EVENTS_ERROR_CODES.notFound, `Unknown event: ${name}`, { name });
        const oldest = this._entries[0]?.seq ?? this._seq + 1;
        let truncated = from + 1 < oldest && from < this._seq;
        const cutoff = options.maxAgeMs !== undefined ? this._now() - options.maxAgeMs : undefined;
        const limit = options.maxEvents !== undefined && options.maxEvents > 0 ? options.maxEvents : Infinity;

        const events: { seq: number; occurrence: McpEventOccurrence }[] = [];
        let seq = Math.max(from, 0);
        for (const entry of this._entries) {
            if (entry.seq <= from || entry.occurrence.name !== name) continue;
            if (cutoff !== undefined && entry.at < cutoff) {
                truncated = true;
                continue;
            }
            if (definition.matches && !definition.matches(args, entry.occurrence.data)) continue;
            if (events.length >= limit) return { events, seq, truncated, hasMore: true };
            events.push({ seq: entry.seq, occurrence: entry.occurrence });
            seq = entry.seq;
        }
        // Nothing more for this client: continue from the head, past what did not match.
        return { events, seq: this._seq, truncated, hasMore: false };
    }

    /** Whether one occurrence goes to a client with these arguments. */
    matches(name: string, args: Readonly<Record<string, unknown>>, occurrence: McpEventOccurrence): boolean {
        const definition = this._definitions.get(name);
        return occurrence.name === name && definition !== undefined && (!definition.matches || definition.matches(args, occurrence.data));
    }
}

// ---------------------------------------------------------------------------
// The server extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Webhook delivery: the contract a delivery service fulfils
// ---------------------------------------------------------------------------

/** Why a webhook endpoint failed, as a category: never the endpoint's own words. */
export type McpWebhookErrorCategory = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

/** The health of a webhook subscription, returned on refresh. */
export interface McpWebhookDeliveryStatus {
    active: boolean;
    lastDeliveryAt: string | null;
    lastError: McpWebhookErrorCategory | null;
    failedSince?: string;
    throttled?: boolean;
    retryAfterMs?: number;
}

/** A validated `events/subscribe`. */
export interface McpWebhookSubscribeRequest {
    /** The server's canonical identifier of the authenticated caller. */
    readonly principal: string;
    readonly url: string;
    /** `whsec_` + base64 of 24 to 64 bytes, already checked. */
    readonly secret: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    /** `null`: from now. */
    readonly cursor: string | null;
    readonly maxAgeMs?: number;
    /** `undefined`: server default; `null`: the client asks for no expiry. */
    readonly ttlMs?: number | null;
}

/** What `events/subscribe` answers, besides `resultType`. */
export interface McpWebhookSubscribeResult {
    id: string;
    refreshBefore: string | null;
    cursor: string | null;
    truncated: boolean;
    deliveryStatus?: McpWebhookDeliveryStatus;
}

/**
 * Delivers events by webhook for an {@link McpEventsExtension}. It owns the
 * subscriptions, the endpoint verification, the signing and the retries.
 * `McpWebhookDispatcher` (from `@cyanmycelium/mcp-core/node`) is the
 * implementation this package ships.
 *
 * Throw an {@link McpEventsError} to refuse: `-32027` with `data.reason` for
 * an endpoint that failed verification, `-32025` for a quota.
 */
export interface IMcpWebhookService {
    /** Accept `http://` callback URLs: for tests and development only. */
    readonly allowsInsecureHttp?: boolean;
    subscribe(request: McpWebhookSubscribeRequest): Promise<McpWebhookSubscribeResult>;
    /** `false` when no subscription has this key. */
    unsubscribe(key: { readonly principal: string; readonly url: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }): Promise<boolean>;
}

/** Whether `secret` is a Standard Webhooks symmetric secret: `whsec_` + base64 of 24 to 64 bytes. */
export function isWebhookSecret(secret: unknown): secret is string {
    if (typeof secret !== "string" || !secret.startsWith("whsec_")) return false;
    const encoded = secret.slice("whsec_".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false;
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const bytes = (encoded.length / 4) * 3 - padding;
    return bytes >= 24 && bytes <= 64;
}

/** Options of {@link McpEventsExtension}. */
export interface McpEventsExtensionOptions {
    /** Suggested delay before the next poll. @default 5000 */
    readonly nextPollMs?: number;
    /** Heartbeat interval of a stream when the client does not ask for one. @default 30000 */
    readonly heartbeatMs?: number;
    /** Bounds of the heartbeat interval a client may ask for. @default 1000 to 300000 */
    readonly minHeartbeatMs?: number;
    readonly maxHeartbeatMs?: number;
    /**
     * Webhook delivery. Without it, `events/subscribe` answers `-32026` and
     * no event is described as delivered by webhook.
     */
    readonly webhooks?: IMcpWebhookService;
    /**
     * The authenticated caller of a request, as the server's canonical
     * identifier (an OAuth `sub`, a service account). Webhook subscriptions
     * are keyed by it and refused without it (`-32024`): an unauthenticated
     * server may offer poll and push, never webhook. A server built per
     * request (Streamable HTTP) usually passes the principal its factory got.
     */
    readonly principal?: string | ((request: IMcpRequestContext) => string | undefined);
}

/** A parsed `events/poll` or `events/stream` request. */
interface IEventRequest {
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly from: number;
}

/**
 * Serves an {@link McpEventLog} as the `io.modelcontextprotocol/events`
 * extension: `events/list`, `events/poll`, `events/stream`, and
 * `notifications/events/list_changed` on listens that ask for
 * `eventsListChanged`.
 *
 * Stateless revisions only, as the extension defines. Webhook delivery
 * (`events/subscribe`, `events/unsubscribe`) is served when
 * {@link McpEventsExtensionOptions.webhooks} is given, to authenticated
 * callers only; otherwise it answers `-32026`.
 */
export class McpEventsExtension implements IMcpServerExtension {
    readonly id = MCP_EVENTS_EXTENSION;
    readonly statelessOnly = true;
    readonly subscriptionFlags = [MCP_EVENTS_LIST_CHANGED_FLAG] as const;
    readonly methods: Readonly<Record<string, McpExtensionHandler>>;

    private readonly _log: McpEventLog;
    private readonly _options: Required<Omit<McpEventsExtensionOptions, "webhooks" | "principal">>;
    private readonly _webhooks: IMcpWebhookService | undefined;
    private readonly _principal: McpEventsExtensionOptions["principal"];
    private readonly _streams = new Set<() => void>();
    private _unsubscribeList: (() => void) | undefined;

    constructor(log: McpEventLog, options: McpEventsExtensionOptions = {}) {
        this._log = log;
        this._options = {
            nextPollMs: options.nextPollMs ?? 5_000,
            heartbeatMs: options.heartbeatMs ?? 30_000,
            minHeartbeatMs: options.minHeartbeatMs ?? 1_000,
            maxHeartbeatMs: options.maxHeartbeatMs ?? 300_000,
        };
        this._webhooks = options.webhooks;
        this._principal = options.principal;
        this.methods = {
            "events/list": (req) => jsonRpcOk(req.id, { events: this._describe() }),
            "events/poll": (req) => this._poll(req),
            "events/stream": (req, ctx) => this._stream(req, ctx),
            "events/subscribe": (req, ctx) => this._subscribe(req, ctx),
            "events/unsubscribe": (req, ctx) => this._unsubscribe(req, ctx),
        };
    }

    settings(): Readonly<Record<string, unknown>> {
        return { listChanged: true };
    }

    attach(host: IMcpExtensionHost): void {
        this._unsubscribeList = this._log.onListChanged.subscribe(() => {
            host.notifyListeners(MCP_EVENTS_LIST_CHANGED_FLAG, "notifications/events/list_changed");
        });
    }

    detach(): void {
        this._unsubscribeList?.();
        this._unsubscribeList = undefined;
        for (const end of [...this._streams]) end();
    }

    /** The descriptors, without `webhook` when no delivery service is configured. */
    private _describe(): McpEventDescriptor[] {
        if (this._webhooks) return this._log.descriptors();
        return this._log
            .descriptors()
            .map((descriptor) => ({ ...descriptor, delivery: descriptor.delivery.filter((mode) => mode !== "webhook") }))
            .filter((descriptor) => descriptor.delivery.length > 0);
    }

    /** The authenticated caller, or `undefined`. */
    private _principalOf(ctx: IMcpRequestContext): string | undefined {
        const principal = typeof this._principal === "function" ? this._principal(ctx) : this._principal;
        return typeof principal === "string" && principal.length > 0 ? principal : undefined;
    }

    /** Checks what `events/subscribe` and `events/unsubscribe` share, or answers the error. */
    private _webhookKey(
        req: JsonRpcRequest,
        ctx: IMcpRequestContext
    ): { service: IMcpWebhookService; principal: string; name: string; args: Record<string, unknown>; url: string } | JsonRpcResponse {
        const service = this._webhooks;
        if (!service)
            return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.unsupported, "Webhook delivery is not supported by this server", { feature: "deliveryMode", value: "webhook" });
        const principal = this._principalOf(ctx);
        if (!principal) return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.forbidden, "Webhook subscriptions need an authenticated caller");
        const params = isRecord(req.params) ? req.params : {};
        const name = params["name"];
        if (typeof name !== "string" || name.length === 0) return jsonRpcError(req.id, -32602, "Missing required parameter: name");
        const args = params["arguments"] === undefined ? {} : params["arguments"];
        if (!isRecord(args)) return jsonRpcError(req.id, -32602, "arguments must be an object");
        const delivery = params["delivery"];
        const url = isRecord(delivery) ? delivery["url"] : undefined;
        if (typeof url !== "string") return jsonRpcError(req.id, -32602, "Missing required parameter: delivery.url");
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return jsonRpcError(req.id, -32602, "delivery.url is not a URL");
        }
        const schemeAllowed = parsed.protocol === "https:" || (service.allowsInsecureHttp === true && parsed.protocol === "http:");
        if (!schemeAllowed || parsed.username || parsed.password) return jsonRpcError(req.id, -32602, "delivery.url must be an https:// URL without credentials");
        return { service, principal, name, args, url: parsed.toString() };
    }

    /** `events/subscribe`: creates or refreshes a webhook subscription. */
    private async _subscribe(req: JsonRpcRequest, ctx: IMcpRequestContext): Promise<JsonRpcResponse> {
        const key = this._webhookKey(req, ctx);
        if ("jsonrpc" in key) return key;
        const definition = this._log.definition(key.name);
        if (!definition) return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.notFound, `Unknown event: ${key.name}`, { kind: "event", name: key.name });
        if (!(definition.delivery ?? ["poll", "push"]).includes("webhook")) {
            return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.unsupported, `Event "${key.name}" is not delivered by webhook`, { feature: "deliveryMode", value: "webhook" });
        }
        const params = isRecord(req.params) ? req.params : {};
        const delivery = params["delivery"] as Record<string, unknown>;
        if (delivery["mode"] !== undefined && delivery["mode"] !== "webhook") return jsonRpcError(req.id, -32602, 'delivery.mode must be "webhook"');
        if (!isWebhookSecret(delivery["secret"])) return jsonRpcError(req.id, -32602, "delivery.secret must be whsec_ followed by the base64 of 24 to 64 bytes");
        const cursor = params["cursor"];
        if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !/^\d+$/.test(cursor)))
            return jsonRpcError(req.id, -32602, `Invalid cursor: ${String(cursor)}`);
        const ttlMs = params["ttlMs"];
        if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== "number" || !(ttlMs >= 0)))
            return jsonRpcError(req.id, -32602, "ttlMs must be a non-negative number or null");
        const maxAgeMs = params["maxAgeMs"];
        try {
            const result = await key.service.subscribe({
                principal: key.principal,
                url: key.url,
                secret: delivery["secret"] as string,
                name: key.name,
                args: key.args,
                cursor: typeof cursor === "string" ? cursor : null,
                ...(typeof maxAgeMs === "number" && maxAgeMs >= 0 ? { maxAgeMs } : {}),
                ...(ttlMs === null ? { ttlMs: null } : typeof ttlMs === "number" ? { ttlMs } : {}),
            });
            return jsonRpcOk(req.id, result);
        } catch (error) {
            return toJsonRpcError(req, error);
        }
    }

    /** `events/unsubscribe`: removes a webhook subscription by its key. */
    private async _unsubscribe(req: JsonRpcRequest, ctx: IMcpRequestContext): Promise<JsonRpcResponse> {
        const key = this._webhookKey(req, ctx);
        if ("jsonrpc" in key) return key;
        try {
            const removed = await key.service.unsubscribe({ principal: key.principal, url: key.url, name: key.name, args: key.args });
            if (!removed) return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.notFound, "No such subscription", { kind: "subscription" });
            return jsonRpcOk(req.id, {});
        } catch (error) {
            return toJsonRpcError(req, error);
        }
    }

    /** Reads `name`, `arguments` and `cursor`, or answers the error. */
    private _parse(req: JsonRpcRequest, delivery: McpEventDelivery): IEventRequest | JsonRpcResponse {
        const params = isRecord(req.params) ? req.params : {};
        const name = params["name"];
        if (typeof name !== "string" || name.length === 0) return jsonRpcError(req.id, -32602, "Missing required parameter: name");
        const definition = this._log.definition(name);
        if (!definition) return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.notFound, `Unknown event: ${name}`, { name });
        if (!(definition.delivery ?? ["poll", "push"]).includes(delivery)) {
            return jsonRpcError(req.id, MCP_EVENTS_ERROR_CODES.unsupported, `Event "${name}" is not delivered by ${delivery}`);
        }
        const args = params["arguments"] === undefined ? {} : params["arguments"];
        if (!isRecord(args)) return jsonRpcError(req.id, -32602, "arguments must be an object");
        const cursor = params["cursor"];
        // `null` (or absent) means "from now on".
        if (cursor === null || cursor === undefined) return { name, args, from: this._log.head };
        if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) return jsonRpcError(req.id, -32602, `Invalid cursor: ${String(cursor)}`);
        return { name, args, from: Number(cursor) };
    }

    private _readOptions(req: JsonRpcRequest): McpEventsReadOptions {
        const params = isRecord(req.params) ? req.params : {};
        const maxAgeMs = params["maxAgeMs"];
        const maxEvents = params["maxEvents"];
        return {
            ...(typeof maxAgeMs === "number" && maxAgeMs >= 0 ? { maxAgeMs } : {}),
            ...(typeof maxEvents === "number" && maxEvents > 0 ? { maxEvents: Math.floor(maxEvents) } : {}),
        };
    }

    private _poll(req: JsonRpcRequest): JsonRpcResponse {
        const parsed = this._parse(req, "poll");
        if ("jsonrpc" in parsed) return parsed;
        try {
            const read = this._log.read(parsed.name, parsed.args, parsed.from, this._readOptions(req));
            const result: McpEventsPollResult = {
                events: read.events.map(({ occurrence }) => occurrence),
                cursor: String(read.seq),
                truncated: read.truncated,
                hasMore: read.hasMore,
                nextPollMs: read.hasMore ? 0 : this._options.nextPollMs,
            };
            return jsonRpcOk(req.id, result);
        } catch (error) {
            return toJsonRpcError(req, error);
        }
    }

    /**
     * `events/stream`: `notifications/events/active` first, then the backlog
     * after the cursor, then each new matching occurrence, with a heartbeat
     * whenever nothing else went out for `heartbeatMs`. Ends when the client
     * cancels it or the server stops.
     */
    private _stream(req: JsonRpcRequest, ctx: IMcpRequestContext): JsonRpcResponse | Promise<JsonRpcResponse> {
        const parsed = this._parse(req, "push");
        if ("jsonrpc" in parsed) return parsed;
        const params = isRecord(req.params) ? req.params : {};
        const asked = params["heartbeatMs"];
        const heartbeatMs = Math.min(
            this._options.maxHeartbeatMs,
            Math.max(this._options.minHeartbeatMs, typeof asked === "number" && asked > 0 ? asked : this._options.heartbeatMs)
        );

        let backlog: McpEventLogRead;
        try {
            backlog = this._log.read(parsed.name, parsed.args, parsed.from, this._readOptions(req));
        } catch (error) {
            return toJsonRpcError(req, error);
        }

        const tag = { [MCP_META.subscriptionId]: req.id };
        let cursor = backlog.seq;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const send = (method: string, params: Record<string, unknown>) => {
            ctx.notify?.(method, { ...params, _meta: tag });
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => send("notifications/events/heartbeat", { cursor: String(cursor) }), heartbeatMs);
        };

        send("notifications/events/active", { cursor: String(cursor), truncated: backlog.truncated, heartbeatMs });
        for (const { seq, occurrence } of backlog.events) send("notifications/events/event", { ...occurrence, cursor: String(seq) });

        return new Promise<JsonRpcResponse>((resolve) => {
            const unsubscribe = this._log.onPublished.subscribe(({ seq, occurrence }) => {
                if (seq <= cursor) return;
                cursor = seq;
                let matched: boolean;
                try {
                    matched = this._log.matches(parsed.name, parsed.args, occurrence);
                } catch (error) {
                    // A recoverable error: the stream stays open.
                    send("notifications/events/error", { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
                    return;
                }
                if (matched) send("notifications/events/event", { ...occurrence, cursor: String(seq) });
            });
            const end = () => {
                this._streams.delete(end);
                unsubscribe();
                if (timer) clearTimeout(timer);
                timer = undefined;
                // Sent only when the server closes the stream; a client must not depend on it.
                resolve(jsonRpcOk(req.id, { _meta: tag }));
            };
            this._streams.add(end);
            ctx.signal?.addEventListener("abort", end, { once: true });
        });
    }
}

function toJsonRpcError(req: JsonRpcRequest, error: unknown): JsonRpcResponse {
    if (error instanceof McpEventsError) return jsonRpcError(req.id, error.code, error.message, error.data);
    return jsonRpcError(req.id, -32603, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// The client side
// ---------------------------------------------------------------------------

/** What an event stream reports to its owner. */
export interface McpEventStreamHandlers {
    /** One occurrence. Deduplicate on `eventId` if you reconnect. */
    onEvent(occurrence: McpEventOccurrence): void;
    /** The stream is active from `cursor`; `truncated` when occurrences were lost before it. */
    onActive?(state: { readonly cursor: string; readonly truncated: boolean; readonly heartbeatMs: number }): void;
    /** A recoverable error the server reported; the stream stays open. */
    onError?(error: { readonly code: number; readonly message: string }): void;
    /** The stream ended for good: refused, terminated by the server, or closed. */
    onClosed?(reason: Error | undefined): void;
}

/** A running event stream. */
export interface McpEventStream {
    /** The cursor of the last occurrence or heartbeat received: where a new stream would resume. */
    readonly cursor: string | null;
    /** Stops the stream; it is not reopened. */
    close(): void;
}

/**
 * The client side of the Events extension, over an {@link McpClient}
 * connected statelessly (`protocol: "stateless"` or `"auto"`).
 *
 * A stream watches its heartbeats: after three intervals of silence it is
 * presumed dead and reopened from the last cursor, as the extension asks.
 */
export class McpEventsClient {
    constructor(private readonly _client: McpClient) {}

    /** Whether the server declared the extension. Call nothing else when it did not. */
    get supported(): boolean {
        return this._client.serverExtension(MCP_EVENTS_EXTENSION) !== undefined;
    }

    async list(): Promise<McpEventDescriptor[]> {
        const events: McpEventDescriptor[] = [];
        let cursor: string | undefined;
        for (const seen = new Set<string>(); ; ) {
            const page = await this._client.request<{ events?: McpEventDescriptor[]; nextCursor?: string }>("events/list", cursor === undefined ? {} : { cursor });
            events.push(...(page.events ?? []));
            if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) return events;
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        }
    }

    /** One poll. `cursor: null` starts from now. */
    poll(name: string, args: Record<string, unknown> = {}, cursor: string | null = null, options: McpEventsReadOptions = {}): Promise<McpEventsPollResult> {
        return this._client.request<McpEventsPollResult>("events/poll", { name, arguments: args, cursor, ...options });
    }

    /** Opens a stream; occurrences arrive on `handlers.onEvent` until {@link McpEventStream.close}. */
    stream(
        name: string,
        args: Record<string, unknown>,
        handlers: McpEventStreamHandlers,
        options: { readonly cursor?: string | null; readonly heartbeatMs?: number; readonly maxAgeMs?: number; readonly reconnect?: boolean } = {}
    ): McpEventStream {
        let cursor: string | null = options.cursor ?? null;
        let closed = false;
        let current: { close(): void } | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let attempts = 0;
        const reconnect = options.reconnect ?? true;

        const finish = (reason: Error | undefined) => {
            if (closed) return;
            closed = true;
            if (watchdog) clearTimeout(watchdog);
            current?.close();
            handlers.onClosed?.(reason);
        };
        const reopenLater = () => {
            if (closed) return;
            // Forget the stream first: closing it settles its `done`, which must not reopen twice.
            const previous = current;
            current = undefined;
            previous?.close();
            if (!reconnect) return finish(new Error("The event stream ended"));
            attempts += 1;
            const delay = Math.min(30_000, 250 * 2 ** Math.min(attempts, 7)) * (0.5 + Math.random() / 2);
            setTimeout(open, delay);
        };
        const arm = (heartbeatMs: number) => {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(reopenLater, heartbeatMs * 3);
        };

        const open = () => {
            if (closed) return;
            let heartbeatMs = options.heartbeatMs ?? 30_000;
            const opened = this._client.openStream(
                "events/stream",
                {
                    name,
                    arguments: args,
                    cursor,
                    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
                    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
                },
                (method, params) => {
                    arm(heartbeatMs);
                    switch (method) {
                        case "notifications/events/active":
                            attempts = 0;
                            heartbeatMs = typeof params["heartbeatMs"] === "number" ? params["heartbeatMs"] : heartbeatMs;
                            arm(heartbeatMs);
                            if (typeof params["cursor"] === "string") cursor = params["cursor"];
                            handlers.onActive?.({ cursor: String(params["cursor"]), truncated: params["truncated"] === true, heartbeatMs });
                            break;
                        case "notifications/events/event": {
                            const { _meta: _ignored, ...occurrence } = params;
                            void _ignored;
                            if (typeof occurrence["cursor"] === "string") cursor = occurrence["cursor"];
                            handlers.onEvent(occurrence as unknown as McpEventOccurrence);
                            break;
                        }
                        case "notifications/events/heartbeat":
                            if (typeof params["cursor"] === "string") cursor = params["cursor"];
                            break;
                        case "notifications/events/error":
                            if (isRecord(params["error"])) handlers.onError?.(params["error"] as { code: number; message: string });
                            break;
                        case "notifications/events/terminated":
                            finish(new Error(isRecord(params["error"]) ? String(params["error"]["message"]) : "The server terminated the event stream"));
                            break;
                    }
                }
            );
            current = opened;
            arm(heartbeatMs);
            opened.done.then(
                // The server ended the stream: reopen from where it stopped.
                () => {
                    if (current === opened) reopenLater();
                },
                // Refused (unknown event, bad arguments): final.
                (error: Error) => {
                    if (current === opened) finish(error);
                }
            );
        };

        open();
        return {
            get cursor() {
                return cursor;
            },
            close: () => finish(undefined),
        };
    }
}
