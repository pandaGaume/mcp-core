import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { isWebhookSecret, LoopbackTransport, McpClient, McpEventLog, McpEventsExtension, McpServerBuilder } from "../src";
import { isGloballyRoutable, McpWebhookDispatcher, signWebhook, verifyWebhook } from "../src/node";
import type { McpWebhookDispatcherOptions } from "../src/node";

/** Webhook delivery of the Events extension (SEP-3415, Standard Webhooks profile). */

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET = `whsec_${randomBytes(32).toString("base64")}`;

describe("Standard Webhooks signing", () => {
    it("matches the published test vector", () => {
        // From the Standard Webhooks specification's reference example.
        const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
        expect(signWebhook(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
        const headers = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: "1614265330", signature: "v1,bad v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };
        expect(verifyWebhook(secret, headers, '{"test": 2432232314}', 300, 1614265330)).toBe(true);
        expect(verifyWebhook(secret, headers, '{"test": 2432232314}', 300, 1614265330 + 301)).toBe(false);
    });

    it("accepts only whsec_ secrets of 24 to 64 bytes", () => {
        expect(isWebhookSecret(SECRET)).toBe(true);
        expect(isWebhookSecret(`whsec_${randomBytes(23).toString("base64")}`)).toBe(false);
        expect(isWebhookSecret(`whsec_${randomBytes(65).toString("base64")}`)).toBe(false);
        expect(isWebhookSecret("hunter2")).toBe(false);
    });
});

describe("SSRF address checks", () => {
    it("allows globally routable addresses only", () => {
        for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isGloballyRoutable(address)).toBe(true);
        for (const address of [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "2002:c0a8:0101::1",
            "localhost",
        ])
            expect(isGloballyRoutable(address), address).toBe(false);
    });
});

/** A webhook receiver that verifies every signature and records what it got. */
class Receiver {
    readonly received: { headers: IncomingMessage["headers"]; body: Record<string, unknown>; verified: boolean }[] = [];
    /** Status per delivery, in order; then 200. */
    statuses: number[] = [];
    echo = true;
    private _server: Server | undefined;
    url = "";

    async start(): Promise<void> {
        this._server = createServer((req, res) => {
            let raw = "";
            req.setEncoding("utf8");
            req.on("data", (chunk: string) => (raw += chunk));
            req.on("end", () => {
                const headers = { id: String(req.headers["webhook-id"]), timestamp: String(req.headers["webhook-timestamp"]), signature: String(req.headers["webhook-signature"]) };
                const body = JSON.parse(raw) as Record<string, unknown>;
                this.received.push({ headers: req.headers, body, verified: verifyWebhook(SECRET, headers, raw) });
                if (body["type"] === "verification") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ challenge: this.echo ? body["challenge"] : "wrong" }));
                    return;
                }
                res.writeHead(this.statuses.shift() ?? 200).end();
            });
        });
        await new Promise<void>((resolve) => this._server!.listen(0, "127.0.0.1", resolve));
        this.url = `http://127.0.0.1:${(this._server.address() as AddressInfo).port}/hooks/plant`;
    }

    events(): Record<string, unknown>[] {
        return this.received.filter((r) => r.body["type"] === undefined).map((r) => r.body);
    }

    stop(): Promise<void> {
        return new Promise((resolve) => (this._server ? this._server.close(() => resolve()) : resolve()));
    }
}

let receiver: Receiver | undefined;
let dispatcher: McpWebhookDispatcher | undefined;
afterEach(async () => {
    dispatcher?.close();
    await receiver?.stop();
    receiver = undefined;
    dispatcher = undefined;
});

async function setup(options: McpWebhookDispatcherOptions = {}, principal: string | undefined = "user:operator") {
    receiver = new Receiver();
    await receiver.start();
    const log = new McpEventLog().define({ name: "alarm", delivery: ["poll", "push", "webhook"], matches: (args, data) => !args["area"] || args["area"] === data["area"] });
    dispatcher = new McpWebhookDispatcher(log, { allowInsecureHttp: true, allowDestination: () => true, retryDelaysMs: [0, 20, 40], ...options });
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder()
        .withTransport(serverEnd)
        .withExtension(new McpEventsExtension(log, { webhooks: dispatcher, principal }))
        .build();
    await server.start();
    const client = new McpClient({ name: "c", version: "1" }, clientEnd, 2_000, { protocol: "stateless" });
    await client.connect();
    const subscribe = (extra: Record<string, unknown> = {}) =>
        client.request<Record<string, unknown>>("events/subscribe", {
            name: "alarm",
            arguments: { area: "nord" },
            delivery: { mode: "webhook", url: receiver!.url, secret: SECRET },
            cursor: null,
            ...extra,
        });
    return { log, client, subscribe, receiver };
}

describe("webhook subscriptions", () => {
    it("verifies the endpoint, then delivers signed events with the subscription id and a safe cursor", async () => {
        const { log, subscribe, receiver } = await setup();
        const result = await subscribe({ ttlMs: 600_000 });
        expect(result).toMatchObject({ resultType: "complete", cursor: "0", truncated: false });
        expect(String(result["id"])).toMatch(/^sub_[0-9a-f]{24}$/);
        expect(receiver.received[0].body["type"]).toBe("verification");

        log.publish("alarm", { area: "sud", tag: "ignored" });
        log.publish("alarm", { area: "nord", tag: "P-101" });
        await settle();
        const delivered = receiver.received.filter((r) => r.body["type"] === undefined);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].verified).toBe(true);
        expect(delivered[0].headers["x-mcp-subscription-id"]).toBe(result["id"]);
        expect(delivered[0].body).toMatchObject({ name: "alarm", data: { area: "nord", tag: "P-101" }, cursor: "1" });
        expect(String(delivered[0].headers["webhook-id"])).toMatch(/^msg_[A-Za-z0-9_-]+$/);
    });

    it("is idempotent per key: a refresh keeps the id and reports delivery status", async () => {
        const { subscribe, log } = await setup();
        const first = await subscribe();
        log.publish("alarm", { area: "nord", tag: "P-1" });
        await settle();
        const again = await subscribe();
        expect(again["id"]).toBe(first["id"]);
        expect(again["deliveryStatus"]).toMatchObject({ active: true, lastError: null });
        expect(again["cursor"]).toBe("1");
        // Verification is reused per (principal, url).
        expect(receiver!.received.filter((r) => r.body["type"] === "verification")).toHaveLength(1);
    });

    it("retries with the same webhook-id and a fresh signature, and does not retry 410", async () => {
        const { subscribe, log, receiver } = await setup();
        await subscribe();
        receiver.statuses = [500, 200];
        log.publish("alarm", { area: "nord", tag: "retried" });
        await settle(120);
        const attempts = receiver.received.filter((r) => r.body["type"] === undefined);
        expect(attempts).toHaveLength(2);
        expect(attempts[1].headers["webhook-id"]).toBe(attempts[0].headers["webhook-id"]);
        expect(attempts.every((a) => a.verified)).toBe(true);

        receiver.statuses = [410];
        log.publish("alarm", { area: "nord", tag: "gone" });
        await settle(120);
        expect(receiver.events().filter((e) => (e["data"] as Record<string, unknown>)["tag"] === "gone")).toHaveLength(1);
    });

    it("refuses an endpoint that does not echo the challenge, and one it may not reach", async () => {
        const { subscribe, receiver } = await setup();
        receiver.echo = false;
        await expect(subscribe()).rejects.toThrow(/-32027/);
        dispatcher!.close();
        await receiver.stop();

        const blocked = await setup({ allowDestination: undefined });
        await expect(blocked.subscribe()).rejects.toMatchObject({ code: -32027, data: { reason: "connection_refused" } });
        expect(blocked.receiver.received).toHaveLength(0);
    });

    it("refuses without a principal, without https, with a bad secret, and an unknown unsubscribe", async () => {
        const anonymous = await setup({}, "");
        await expect(anonymous.subscribe()).rejects.toThrow(/-32024/);
        dispatcher!.close();
        await receiver!.stop();

        const strict = await setup({ allowInsecureHttp: false });
        await expect(strict.subscribe()).rejects.toThrow(/-32602.*https/);
        await expect(strict.subscribe({ delivery: { mode: "webhook", url: "https://example.com/h", secret: "whsec_short" } })).rejects.toThrow(/-32602.*whsec_/);
        await expect(strict.client.request("events/unsubscribe", { name: "alarm", arguments: {}, delivery: { url: "https://example.com/h" } })).rejects.toThrow(/-32023/);
    });

    it("stops delivering after unsubscribe", async () => {
        const { subscribe, client, log, receiver } = await setup();
        await subscribe();
        await client.request("events/unsubscribe", { name: "alarm", arguments: { area: "nord" }, delivery: { url: receiver.url } });
        log.publish("alarm", { area: "nord", tag: "late" });
        await settle();
        expect(receiver.events()).toHaveLength(0);
        expect(dispatcher!.size).toBe(0);
    });

    it("grants a bounded lifetime: no expiry only with a store, short suggestions clamped up", async () => {
        const { subscribe } = await setup({ minTtlMs: 60_000, maxTtlMs: 120_000 });
        const before = Date.now();
        const noExpiry = await subscribe({ ttlMs: null });
        expect(noExpiry["refreshBefore"]).not.toBeNull();
        expect(Date.parse(String(noExpiry["refreshBefore"]))).toBeLessThanOrEqual(before + 121_000);
        const short = await subscribe({ ttlMs: 10 });
        expect(Date.parse(String(short["refreshBefore"]))).toBeGreaterThanOrEqual(before + 59_000);
    });

    it("terminates subscriptions to an event that is removed, with a signed envelope", async () => {
        const { subscribe, log, receiver } = await setup();
        await subscribe();
        log.undefine("alarm");
        await settle();
        const terminated = receiver.received.find((r) => r.body["type"] === "terminated");
        expect(terminated?.verified).toBe(true);
        expect(terminated?.body["error"]).toMatchObject({ code: -32023 });
        expect(String(terminated?.headers["webhook-id"])).toMatch(/^msg_terminated_/);
        expect(dispatcher!.size).toBe(0);
    });

    it("lists webhook delivery only when a service is configured", async () => {
        const { client } = await setup();
        const listed = await client.request<{ events: { delivery: string[] }[] }>("events/list");
        expect(listed.events[0].delivery).toContain("webhook");

        const log = new McpEventLog().define({ name: "alarm", delivery: ["poll", "webhook"] });
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        await new McpServerBuilder().withTransport(serverEnd).withExtension(new McpEventsExtension(log)).build().start();
        const bare = new McpClient({ name: "c", version: "1" }, clientEnd, 2_000, { protocol: "stateless" });
        await bare.connect();
        expect((await bare.request<{ events: { delivery: string[] }[] }>("events/list")).events[0].delivery).toEqual(["poll"]);
    });
});
