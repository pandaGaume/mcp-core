import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import { McpEventsError } from "../extensions/events";
import type {
    IMcpWebhookService,
    McpEventLog,
    McpWebhookDeliveryStatus,
    McpWebhookErrorCategory,
    McpWebhookSubscribeRequest,
    McpWebhookSubscribeResult,
} from "../extensions/events";
import { MCP_EVENTS_ERROR_CODES } from "../interfaces/mcp.events.interfaces";
import type { McpEventOccurrence } from "../interfaces/mcp.events.interfaces";

// ---------------------------------------------------------------------------
// Standard Webhooks signing
// ---------------------------------------------------------------------------

/** The key bytes of a `whsec_` secret. */
function secretKey(secret: string): Buffer {
    return Buffer.from(secret.slice("whsec_".length), "base64");
}

/**
 * The Standard Webhooks `v1` signature of one message:
 * `v1,` + base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`).
 */
export function signWebhook(secret: string, id: string, timestamp: number | string, body: string): string {
    return `v1,${createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * Checks a Standard Webhooks signature header (several space-separated
 * signatures are allowed during a secret rotation) in constant time, and the
 * timestamp's freshness. For receivers and tests.
 */
export function verifyWebhook(
    secret: string,
    headers: { readonly id: string; readonly timestamp: string; readonly signature: string },
    body: string,
    toleranceSec = 300,
    nowSec = Math.floor(Date.now() / 1000)
): boolean {
    const timestamp = Number(headers.timestamp);
    if (!Number.isInteger(timestamp) || Math.abs(nowSec - timestamp) > toleranceSec) return false;
    const expected = Buffer.from(signWebhook(secret, headers.id, headers.timestamp, body));
    return headers.signature.split(" ").some((candidate) => {
        const given = Buffer.from(candidate);
        return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

// ---------------------------------------------------------------------------
// SSRF: which addresses a delivery may reach
// ---------------------------------------------------------------------------

/** Not globally routable, per the IANA special-purpose registries (IPv4 and IPv6). */
const NON_GLOBAL = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const)
    NON_GLOBAL.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const)
    NON_GLOBAL.addSubnet(network, prefix, "ipv6");

/** The IPv4 address an IPv6 one embeds (mapped, NAT64, 6to4), else `undefined`. */
function embeddedIpv4(address: string): string | undefined {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return mapped[1];
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (nat64) return nat64[1];
    const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i.exec(address);
    if (sixToFour) {
        const high = parseInt(sixToFour[1], 16);
        const low = parseInt(sixToFour[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return undefined;
}

/** Whether `address` is globally routable: neither private, loopback, link-local, documentation, multicast nor reserved. */
export function isGloballyRoutable(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !NON_GLOBAL.check(address, "ipv4");
    if (family === 6) {
        const v4 = embeddedIpv4(address);
        if (v4 !== undefined) return isIP(v4) === 4 && !NON_GLOBAL.check(v4, "ipv4");
        return !NON_GLOBAL.check(address, "ipv6");
    }
    return false;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/** A webhook subscription as a durable store keeps it (no-expiry subscriptions). */
export interface McpWebhookRecord {
    readonly id: string;
    readonly principal: string;
    readonly url: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly secret: string;
}

/**
 * Durable storage for no-expiry subscriptions, which the extension requires
 * to survive a restart. It holds signing secrets: protect it like any other
 * credential store.
 */
export interface IMcpWebhookStore {
    load(): Promise<readonly McpWebhookRecord[]>;
    save(record: McpWebhookRecord): Promise<void>;
    remove(id: string): Promise<void>;
}

/** Options of {@link McpWebhookDispatcher}. */
export interface McpWebhookDispatcherOptions {
    /** Lifetime granted when the client suggests none. @default 1 hour */
    readonly defaultTtlMs?: number;
    /** Shorter suggestions are clamped up to this. @default 1 minute */
    readonly minTtlMs?: number;
    /** Longer suggestions are capped to this. @default 1 day */
    readonly maxTtlMs?: number;
    /** Grants no expiry to clients that ask for it; required to do so. Without it, `ttlMs: null` gets {@link maxTtlMs}. */
    readonly store?: IMcpWebhookStore;
    /** Delay before each attempt of an event; its length bounds the attempts. @default 0, 1 min, 3 min, 7 min */
    readonly retryDelaysMs?: readonly number[];
    /** How long one POST may take. @default 5000 */
    readonly timeoutMs?: number;
    /** Events whose body is larger are abandoned, as a receiver would refuse them (`413`). @default 256 KiB */
    readonly maxBodyBytes?: number;
    /**
     * Allows a destination that is not globally routable: a receiver on the
     * plant network, say. Called at delivery time with the resolved address.
     * @default none: only globally routable addresses
     */
    readonly allowDestination?: (url: URL, address: string) => boolean;
    /** URLs verified without a challenge (an operator allowlist). */
    readonly trustedUrls?: (url: URL) => boolean;
    /** Accept `http://` callbacks. Tests and development only. @default false */
    readonly allowInsecureHttp?: boolean;
    /** Most subscriptions one principal may hold. @default 100 */
    readonly maxSubscriptionsPerPrincipal?: number;
    /** How long a successful verification of `(principal, url)` is reused. @default 1 day */
    readonly verificationTtlMs?: number;
    /** How long the previous secret still signs after a rotation. @default 5 minutes */
    readonly rotationGraceMs?: number;
    /** Suspend a subscription when, over the last hour, at least this many attempts failed at this rate. @default 100 attempts, 0.95 */
    readonly suspendAfter?: { readonly attempts: number; readonly failureRate: number };
    /** Clock, for tests. */
    readonly now?: () => number;
}

/** One event on its way to one subscription. */
interface IDelivery {
    readonly seq: number;
    readonly messageId: string;
    readonly occurrence: McpEventOccurrence;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
    sending: boolean;
}

interface ISubscription {
    readonly id: string;
    readonly principal: string;
    readonly url: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    secret: string;
    previousSecret?: { readonly secret: string; readonly until: number };
    /** `null`: no expiry. */
    expiresAt: number | null;
    active: boolean;
    lastDeliveryAt: number | null;
    lastError: McpWebhookErrorCategory | null;
    failedSince: number | null;
    /** The last log position this subscription considered (delivered, skipped or abandoned). */
    position: number;
    readonly pending: Map<number, IDelivery>;
    /** Attempt outcomes of the last hour, for suspension. */
    readonly outcomes: { at: number; ok: boolean }[];
}

/** Canonical JSON: keys sorted, so equal arguments give equal keys. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function randomId(prefix: string): string {
    return `${prefix}${randomBytes(16)
        .toString("base64url")
        .replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** What one POST came to. */
type PostOutcome =
    | { readonly ok: true; readonly status: number; readonly body: string }
    | { readonly ok: false; readonly category: McpWebhookErrorCategory; readonly retryable: boolean };

/**
 * Delivers {@link McpEventLog} occurrences to webhook subscriptions, as the
 * Events extension specifies (SEP-3415, Standard Webhooks profile). Give it
 * to `McpEventsExtension` as `webhooks`; one dispatcher serves every server
 * sharing the log.
 *
 * - **Signing**: `webhook-id` (per message, kept across retries),
 *   `webhook-timestamp`, `webhook-signature: v1,...` (both secrets during a
 *   rotation), `X-MCP-Subscription-Id`.
 * - **SSRF**: the callback host is resolved at each delivery, the address
 *   must be globally routable unless `allowDestination` says otherwise, and
 *   the POST goes to that very address (Host and SNI keep the name). No
 *   redirect is followed.
 * - **Verification**: a signed `verification` challenge the endpoint must
 *   echo before the first delivery, unless `trustedUrls` vouches for it;
 *   reused per `(principal, url)`.
 * - **Retries**: each event independently, bounded by `retryDelaysMs`;
 *   `410` and `413` are not retried; an exhausted event is abandoned.
 * - **Cursor**: each body carries the safe watermark, the position before
 *   which every event was acknowledged or abandoned.
 * - **Lifetime**: TTLs are granted between `minTtlMs` and `maxTtlMs`; no
 *   expiry only with a `store`. Removing an event terminates its
 *   subscriptions with a signed `terminated` envelope.
 *
 * Not provided: the `/.well-known/mcp-webhook-receiver.json` verification
 * path and `v1a` (ed25519) signatures.
 */
export class McpWebhookDispatcher implements IMcpWebhookService {
    readonly allowsInsecureHttp: boolean;

    private readonly _log: McpEventLog;
    private readonly _options: McpWebhookDispatcherOptions;
    private readonly _now: () => number;
    private readonly _subscriptions = new Map<string, ISubscription>();
    private readonly _verified = new Map<string, number>();
    private readonly _verifications = new Map<string, number[]>();
    private readonly _unsubscribes: (() => void)[] = [];
    private readonly _sweep: ReturnType<typeof setInterval>;

    constructor(log: McpEventLog, options: McpWebhookDispatcherOptions = {}) {
        this._log = log;
        this._options = options;
        this._now = options.now ?? Date.now;
        this.allowsInsecureHttp = options.allowInsecureHttp ?? false;
        this._unsubscribes.push(log.onPublished.subscribe(({ seq, occurrence }) => this._onPublished(seq, occurrence)));
        this._unsubscribes.push(log.onListChanged.subscribe(() => this._onListChanged()));
        this._sweep = setInterval(() => this._expire(), 30_000);
        this._sweep.unref?.();
    }

    /** Number of live subscriptions. */
    get size(): number {
        return this._subscriptions.size;
    }

    /** Reloads the no-expiry subscriptions from the store, after a restart. */
    async restore(): Promise<number> {
        const records = (await this._options.store?.load()) ?? [];
        for (const record of records) {
            if (this._subscriptions.has(record.id)) continue;
            this._subscriptions.set(record.id, this._create(record, null, this._log.head));
            // The stored record exists only because the endpoint was verified.
            this._verified.set(`${record.principal}\n${record.url}`, Infinity);
        }
        return records.length;
    }

    /** Stops every delivery and timer. Subscriptions are dropped, except what the store keeps. */
    close(): void {
        clearInterval(this._sweep);
        for (const unsubscribe of this._unsubscribes.splice(0)) unsubscribe();
        for (const subscription of this._subscriptions.values()) this._clearPending(subscription);
        this._subscriptions.clear();
    }

    /**
     * Ends a subscription from the server's side (revoked access, say): a
     * signed `terminated` envelope goes to the endpoint, best effort, and the
     * subscription is removed.
     */
    async terminate(id: string, error: { readonly code: number; readonly message: string; readonly data?: unknown }): Promise<boolean> {
        const subscription = this._subscriptions.get(id);
        if (!subscription) return false;
        await this._remove(subscription);
        await this._post(subscription, randomId("msg_terminated_"), JSON.stringify({ type: "terminated", error }));
        return true;
    }

    async subscribe(request: McpWebhookSubscribeRequest): Promise<McpWebhookSubscribeResult> {
        const url = new URL(request.url);
        if (url.protocol !== "https:" && !(this.allowsInsecureHttp && url.protocol === "http:")) {
            throw new McpEventsError(-32602, "delivery.url must be an https:// URL");
        }
        const id = this._idOf(request);
        let existing = this._subscriptions.get(id);
        // An expired subscription is gone: this is a fresh subscribe, replaying from the client's cursor.
        if (existing && existing.expiresAt !== null && existing.expiresAt <= this._now()) {
            await this._remove(existing);
            existing = undefined;
        }
        const expiresAt = this._grant(request.ttlMs);

        if (existing) {
            // A refresh: new grant, new secret (the old one keeps signing for a while), liveness restored.
            if (existing.secret !== request.secret) {
                existing.previousSecret = { secret: existing.secret, until: this._now() + (this._options.rotationGraceMs ?? 5 * 60_000) };
                existing.secret = request.secret;
            }
            const wasSuspended = !existing.active;
            existing.expiresAt = expiresAt;
            existing.active = true;
            await this._persist(existing);
            const status = this._status(existing, wasSuspended);
            if (wasSuspended) for (const delivery of existing.pending.values()) this._schedule(existing, delivery, 0);
            return { id, refreshBefore: this._iso(expiresAt), cursor: String(this._watermark(existing)), truncated: false, deliveryStatus: status };
        }

        const owned = [...this._subscriptions.values()].filter((s) => s.principal === request.principal).length;
        const max = this._options.maxSubscriptionsPerPrincipal ?? 100;
        if (owned >= max) throw new McpEventsError(MCP_EVENTS_ERROR_CODES.resourceExhausted, "Too many webhook subscriptions", { limit: "subscriptions", max });

        const from = request.cursor === null ? this._log.head : Number(request.cursor);
        const backlog = this._log.read(request.name, request.args, from, request.maxAgeMs !== undefined ? { maxAgeMs: request.maxAgeMs } : {});
        const subscription = this._create(
            { id, principal: request.principal, url: url.toString(), name: request.name, args: request.args, secret: request.secret },
            expiresAt,
            from
        );

        await this._verify(subscription);
        this._subscriptions.set(id, subscription);
        await this._persist(subscription);
        for (const { seq, occurrence } of backlog.events) this._enqueue(subscription, seq, occurrence);
        subscription.position = Math.max(subscription.position, backlog.seq);
        return { id, refreshBefore: this._iso(expiresAt), cursor: String(this._watermark(subscription)), truncated: backlog.truncated };
    }

    async unsubscribe(key: { readonly principal: string; readonly url: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }): Promise<boolean> {
        const subscription = this._subscriptions.get(this._idOf(key));
        if (!subscription) return false;
        await this._remove(subscription);
        return true;
    }

    // -- subscriptions --------------------------------------------------------

    /** Deterministic over `(principal, url, name, arguments)`; a routing handle, never a credential. */
    private _idOf(key: { readonly principal: string; readonly url: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }): string {
        const digest = createHash("sha256")
            .update(canonical([key.principal, new URL(key.url).toString(), key.name, key.args]))
            .digest("hex");
        return `sub_${digest.slice(0, 24)}`;
    }

    private _create(record: McpWebhookRecord, expiresAt: number | null, position: number): ISubscription {
        return { ...record, expiresAt, active: true, lastDeliveryAt: null, lastError: null, failedSince: null, position, pending: new Map(), outcomes: [] };
    }

    /** The granted expiry: clamped between the bounds; `null` only when asked for and a store can keep it. */
    private _grant(ttlMs: number | null | undefined): number | null {
        const min = this._options.minTtlMs ?? 60_000;
        const max = this._options.maxTtlMs ?? 24 * 3_600_000;
        if (ttlMs === null) return this._options.store ? null : this._now() + max;
        const asked = ttlMs ?? this._options.defaultTtlMs ?? 3_600_000;
        return this._now() + Math.min(max, Math.max(min, asked));
    }

    private _iso(at: number | null): string | null {
        return at === null ? null : new Date(at).toISOString();
    }

    private async _persist(subscription: ISubscription): Promise<void> {
        const store = this._options.store;
        if (!store) return;
        if (subscription.expiresAt === null) {
            await store.save({
                id: subscription.id,
                principal: subscription.principal,
                url: subscription.url,
                name: subscription.name,
                args: subscription.args,
                secret: subscription.secret,
            });
        } else {
            await store.remove(subscription.id);
        }
    }

    private async _remove(subscription: ISubscription): Promise<void> {
        this._clearPending(subscription);
        this._subscriptions.delete(subscription.id);
        await this._options.store?.remove(subscription.id);
    }

    private _clearPending(subscription: ISubscription): void {
        for (const delivery of subscription.pending.values()) if (delivery.timer) clearTimeout(delivery.timer);
        subscription.pending.clear();
    }

    private _expire(): void {
        const now = this._now();
        for (const subscription of [...this._subscriptions.values()]) {
            if (subscription.expiresAt !== null && subscription.expiresAt <= now) void this._remove(subscription);
        }
    }

    /** An event removed from the log ends the subscriptions to it. */
    private _onListChanged(): void {
        for (const subscription of [...this._subscriptions.values()]) {
            if (this._log.definition(subscription.name)) continue;
            void this.terminate(subscription.id, {
                code: MCP_EVENTS_ERROR_CODES.notFound,
                message: "The event no longer exists",
                data: { kind: "event", name: subscription.name },
            });
        }
    }

    private _status(subscription: ISubscription, wasSuspended: boolean): McpWebhookDeliveryStatus {
        return {
            // `false` tells the client delivery had been suspended; this refresh reactivated it.
            active: !wasSuspended,
            lastDeliveryAt: this._iso(subscription.lastDeliveryAt),
            lastError: subscription.lastError,
            ...(subscription.failedSince !== null ? { failedSince: new Date(subscription.failedSince).toISOString() } : {}),
        };
    }

    /** The safe-to-persist position: everything at or before it was acknowledged or abandoned. */
    private _watermark(subscription: ISubscription): number {
        let lowest = Infinity;
        for (const seq of subscription.pending.keys()) lowest = Math.min(lowest, seq);
        return lowest === Infinity ? subscription.position : Math.min(subscription.position, lowest - 1);
    }

    // -- delivery -------------------------------------------------------------

    private _onPublished(seq: number, occurrence: McpEventOccurrence): void {
        const now = this._now();
        for (const subscription of this._subscriptions.values()) {
            if (subscription.expiresAt !== null && subscription.expiresAt <= now) continue;
            if (seq <= subscription.position) continue;
            let matched = false;
            try {
                matched = this._log.matches(subscription.name, subscription.args, occurrence);
            } catch {
                matched = false;
            }
            if (matched) this._enqueue(subscription, seq, occurrence);
            subscription.position = Math.max(subscription.position, seq);
        }
    }

    private _enqueue(subscription: ISubscription, seq: number, occurrence: McpEventOccurrence): void {
        const delivery: IDelivery = { seq, messageId: randomId("msg_"), occurrence, attempt: 0, sending: false };
        subscription.pending.set(seq, delivery);
        if (subscription.active) this._schedule(subscription, delivery, this._delays()[0] ?? 0);
    }

    private _delays(): readonly number[] {
        return this._options.retryDelaysMs ?? [0, 60_000, 180_000, 420_000];
    }

    private _schedule(subscription: ISubscription, delivery: IDelivery, delay: number): void {
        if (delivery.timer) clearTimeout(delivery.timer);
        delivery.timer = setTimeout(() => void this._attempt(subscription, delivery), delay);
        delivery.timer.unref?.();
    }

    private async _attempt(subscription: ISubscription, delivery: IDelivery): Promise<void> {
        delivery.timer = undefined;
        if (!this._subscriptions.has(subscription.id) || !subscription.pending.has(delivery.seq) || !subscription.active || delivery.sending) return;
        delivery.sending = true;
        delivery.attempt += 1;
        // The cursor is computed at send time, with this event still pending.
        const body = JSON.stringify({ ...delivery.occurrence, cursor: String(this._watermark(subscription)) });
        let outcome: PostOutcome;
        if (Buffer.byteLength(body) > (this._options.maxBodyBytes ?? 256 * 1024)) outcome = { ok: false, category: "http_4xx", retryable: false };
        else outcome = await this._post(subscription, delivery.messageId, body);
        delivery.sending = false;
        if (!subscription.pending.has(delivery.seq)) return;

        this._record(subscription, outcome.ok);
        if (outcome.ok) {
            subscription.lastDeliveryAt = this._now();
            subscription.lastError = null;
            subscription.failedSince = null;
            subscription.pending.delete(delivery.seq);
            return;
        }
        subscription.lastError = outcome.category;
        subscription.failedSince ??= this._now();
        const delays = this._delays();
        if (!outcome.retryable || delivery.attempt >= delays.length) {
            // Abandoned: the watermark moves past it; a durable upstream would recover it by cursor.
            subscription.pending.delete(delivery.seq);
            return;
        }
        if (this._shouldSuspend(subscription)) {
            subscription.active = false;
            return;
        }
        this._schedule(subscription, delivery, delays[delivery.attempt] ?? 0);
    }

    /** Keeps an hour of outcomes. */
    private _record(subscription: ISubscription, ok: boolean): void {
        const now = this._now();
        subscription.outcomes.push({ at: now, ok });
        while (subscription.outcomes.length > 0 && subscription.outcomes[0].at < now - 3_600_000) subscription.outcomes.shift();
    }

    private _shouldSuspend(subscription: ISubscription): boolean {
        const rule = this._options.suspendAfter ?? { attempts: 100, failureRate: 0.95 };
        const attempts = subscription.outcomes.length;
        if (attempts < rule.attempts) return false;
        const failures = subscription.outcomes.filter((o) => !o.ok).length;
        return failures / attempts > rule.failureRate;
    }

    /** Proves the endpoint wants these deliveries, once per `(principal, url)`, or throws `-32027`. */
    private async _verify(subscription: ISubscription): Promise<void> {
        const key = `${subscription.principal}\n${subscription.url}`;
        const until = this._verified.get(key);
        if (until !== undefined && until > this._now()) return;
        if (this._options.trustedUrls?.(new URL(subscription.url))) {
            this._verified.set(key, this._now() + (this._options.verificationTtlMs ?? 86_400_000));
            return;
        }
        // Rate-limited per destination host, so subscriptions cannot be used to flood a victim.
        const host = new URL(subscription.url).host;
        const recent = (this._verifications.get(host) ?? []).filter((at) => at > this._now() - 60_000);
        if (recent.length >= 10) throw new McpEventsError(MCP_EVENTS_ERROR_CODES.resourceExhausted, "Too many verifications for this host", { limit: "verifications", max: 10 });
        recent.push(this._now());
        this._verifications.set(host, recent);

        const challenge = randomBytes(24).toString("base64url");
        const outcome = await this._post(subscription, randomId("msg_verification_"), JSON.stringify({ type: "verification", challenge }));
        if (!outcome.ok) throw new McpEventsError(MCP_EVENTS_ERROR_CODES.callbackEndpointError, "The callback endpoint could not be verified", { reason: outcome.category });
        let echoed: unknown;
        try {
            echoed = (JSON.parse(outcome.body) as { challenge?: unknown }).challenge;
        } catch {
            echoed = undefined;
        }
        const expected = Buffer.from(challenge);
        const given = Buffer.from(typeof echoed === "string" ? echoed : "");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            throw new McpEventsError(MCP_EVENTS_ERROR_CODES.callbackEndpointError, "The callback endpoint did not echo the challenge", { reason: "challenge_failed" });
        }
        this._verified.set(key, this._now() + (this._options.verificationTtlMs ?? 86_400_000));
    }

    /** Signs and POSTs one body to the subscription's endpoint, over the SSRF-hardened path. */
    private async _post(subscription: ISubscription, messageId: string, body: string): Promise<PostOutcome> {
        const url = new URL(subscription.url);
        const timestamp = Math.floor(this._now() / 1000);
        const signatures = [signWebhook(subscription.secret, messageId, timestamp, body)];
        if (subscription.previousSecret && subscription.previousSecret.until > this._now()) {
            signatures.push(signWebhook(subscription.previousSecret.secret, messageId, timestamp, body));
        }

        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        let address: string | undefined;
        try {
            const candidates = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
            address = candidates.find((candidate) => isGloballyRoutable(candidate) || this._options.allowDestination?.(url, candidate) === true);
        } catch {
            address = undefined;
        }
        // An address we may not reach is reported as unreachable: no oracle on what the name resolved to.
        if (address === undefined) return { ok: false, category: "connection_refused", retryable: true };

        const secure = url.protocol === "https:";
        const transport = secure ? https : http;
        return new Promise<PostOutcome>((resolve) => {
            let settled = false;
            const settle = (outcome: PostOutcome) => {
                if (settled) return;
                settled = true;
                resolve(outcome);
            };
            const request = transport.request(
                {
                    host: address,
                    port: url.port || (secure ? 443 : 80),
                    path: `${url.pathname}${url.search}`,
                    method: "POST",
                    agent: false,
                    ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
                    headers: {
                        Host: url.host,
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                        "webhook-id": messageId,
                        "webhook-timestamp": String(timestamp),
                        "webhook-signature": signatures.join(" "),
                        "X-MCP-Subscription-Id": subscription.id,
                    },
                    timeout: this._options.timeoutMs ?? 5_000,
                },
                (response) => {
                    const status = response.statusCode ?? 0;
                    let received = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                        // Only a challenge echo is read; never more than a few KiB.
                        if (received.length < 4_096) received += chunk;
                    });
                    response.on("end", () => {
                        if (status >= 200 && status < 300) settle({ ok: true, status, body: received });
                        // No redirect is followed: a 3xx is a refusal.
                        else if (status >= 500) settle({ ok: false, category: "http_5xx", retryable: true });
                        // 410 and 413 say "do not retry"; a redirect would not get better either.
                        else settle({ ok: false, category: "http_4xx", retryable: status >= 400 && status !== 410 && status !== 413 });
                    });
                    response.on("error", () => settle({ ok: false, category: "connection_refused", retryable: true }));
                }
            );
            request.on("timeout", () => {
                request.destroy();
                settle({ ok: false, category: "timeout", retryable: true });
            });
            request.on("error", (error: NodeJS.ErrnoException) => settle({ ok: false, category: categoryOf(error), retryable: true }));
            request.end(body);
        });
    }
}

function categoryOf(error: NodeJS.ErrnoException): McpWebhookErrorCategory {
    const code = String(error.code ?? "");
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
    if (/CERT|SSL|TLS/i.test(code) || /certificate|tls|ssl/i.test(error.message)) return "tls_error";
    return "connection_refused";
}
