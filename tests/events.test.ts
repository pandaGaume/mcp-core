import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LoopbackTransport, MCP_META, McpClient, McpEventLog, McpEventsClient, McpEventsExtension, McpServer, McpServerBuilder } from "../src";
import { StreamableHttpEndpoint, StreamableHttpTransport } from "../src/node";
import type { McpEventOccurrence } from "../src/interfaces";

/** The Events extension (`io.modelcontextprotocol/events`), stateless revisions only. */

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function alarmLog(capacity = 100): McpEventLog {
    return new McpEventLog({ capacity }).define({
        name: "alarm",
        description: "Process alarms",
        inputSchema: { type: "object", properties: { area: { type: "string" } } },
        matches: (args, data) => args["area"] === undefined || args["area"] === data["area"],
    });
}

async function connected(log: McpEventLog, protocol: "stateless" | "legacy" = "stateless") {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder()
        .withName("plant")
        .withTransport(serverEnd)
        .withExtension(new McpEventsExtension(log, { nextPollMs: 1_000 }))
        .build() as McpServer;
    await server.start();
    const client = new McpClient({ name: "c", version: "1" }, clientEnd, 2_000, { protocol });
    await client.connect();
    return { server, client, events: new McpEventsClient(client) };
}

describe("McpEventLog", () => {
    it("reads by cursor, filters by arguments, caps with maxEvents and reports truncation", () => {
        const log = alarmLog(3);
        expect(log.head).toBe(0);
        log.publish("alarm", { area: "nord", tag: "P-1" });
        log.publish("alarm", { area: "sud", tag: "P-2" });
        log.publish("alarm", { area: "nord", tag: "P-3" });
        const nord = log.read("alarm", { area: "nord" }, 0);
        expect(nord.events.map((e) => e.occurrence.data["tag"])).toEqual(["P-1", "P-3"]);
        expect(nord).toMatchObject({ seq: 3, truncated: false, hasMore: false });
        expect(log.read("alarm", {}, 0, { maxEvents: 1 })).toMatchObject({ seq: 1, hasMore: true });

        log.publish("alarm", { area: "nord", tag: "P-4" });
        // The log keeps 3: position 1 is gone, so a reader from 0 lost it.
        expect(log.read("alarm", {}, 0).truncated).toBe(true);
        expect(log.read("alarm", {}, 1).truncated).toBe(false);
        expect(() => log.read("nothing", {}, 0)).toThrow(/Unknown event/);
    });
});

describe("events over the stateless protocol", () => {
    it("is declared in server/discover and absent from an initialize session", async () => {
        const modern = await connected(alarmLog());
        expect(modern.client.serverExtension("io.modelcontextprotocol/events")).toEqual({ listChanged: true });
        expect(modern.events.supported).toBe(true);

        const legacy = await connected(alarmLog(), "legacy");
        expect(legacy.client.serverExtension("io.modelcontextprotocol/events")).toBeUndefined();
        await expect(legacy.client.request("events/list")).rejects.toThrow(/-32601/);
    });

    it("lists and polls from now, then from the returned cursor", async () => {
        const log = alarmLog();
        const { events } = await connected(log);
        expect((await events.list()).map((e) => e.name)).toEqual(["alarm"]);

        log.publish("alarm", { area: "nord", tag: "before" });
        const first = await events.poll("alarm", { area: "nord" }, null);
        expect(first).toMatchObject({ events: [], truncated: false, hasMore: false, nextPollMs: 1_000, cursor: "1" });

        log.publish("alarm", { area: "nord", tag: "P-101" });
        log.publish("alarm", { area: "sud", tag: "P-202" });
        const second = await events.poll("alarm", { area: "nord" }, first.cursor);
        expect(second.events.map((e) => e.data["tag"])).toEqual(["P-101"]);
        expect(second.cursor).toBe("3");
        await expect(events.poll("nothing", {}, null)).rejects.toThrow(/-32023/);
        await expect(events.poll("alarm", {}, "not-a-cursor")).rejects.toThrow(/-32602/);
    });

    it("streams: active first, the backlog, then live occurrences, until closed", async () => {
        const log = alarmLog();
        const { events } = await connected(log);
        log.publish("alarm", { area: "nord", tag: "backlog" });
        const seen: McpEventOccurrence[] = [];
        const states: { cursor: string; truncated: boolean }[] = [];
        const stream = events.stream("alarm", { area: "nord" }, { onEvent: (e) => seen.push(e), onActive: (s) => states.push(s) }, { cursor: "0", heartbeatMs: 1_000 });
        await settle();
        log.publish("alarm", { area: "sud", tag: "other" });
        log.publish("alarm", { area: "nord", tag: "live" });
        await settle();
        expect(states).toEqual([{ cursor: "1", truncated: false, heartbeatMs: 1_000 }]);
        expect(seen.map((e) => [e.data["tag"], e.cursor])).toEqual([
            ["backlog", "1"],
            ["live", "3"],
        ]);
        expect(stream.cursor).toBe("3");

        stream.close();
        await settle();
        log.publish("alarm", { area: "nord", tag: "after" });
        await settle();
        expect(seen).toHaveLength(2);
    });

    it("sends heartbeats when nothing else happens, and refuses an unknown event at once", async () => {
        const log = alarmLog();
        const { client, events } = await connected(log);
        const methods: string[] = [];
        client.onNotification.subscribe((message) => methods.push(message.method));
        const stream = events.stream("alarm", {}, { onEvent: () => undefined }, { heartbeatMs: 1_000 });
        await settle(1_150);
        expect(methods.filter((m) => m === "notifications/events/heartbeat").length).toBeGreaterThanOrEqual(1);
        stream.close();

        const closed = new Promise<Error | undefined>((resolve) => events.stream("nothing", {}, { onEvent: () => undefined, onClosed: resolve }));
        expect((await closed)?.message).toMatch(/-32023/);
    });

    it("announces a new event on listens that asked for eventsListChanged", async () => {
        const log = alarmLog();
        const { client } = await connected(log);
        const tags: unknown[] = [];
        const listen = client.openStream("subscriptions/listen", { notifications: { eventsListChanged: true } }, (method, params) =>
            tags.push([method, (params["_meta"] as Record<string, unknown>)[MCP_META.subscriptionId]])
        );
        await settle();
        log.define({ name: "trip" });
        await settle();
        expect(tags).toEqual([
            ["notifications/subscriptions/acknowledged", listen.id],
            ["notifications/events/list_changed", listen.id],
        ]);
        listen.close();
    });

    it("refuses webhook delivery with -32026", async () => {
        const { client } = await connected(alarmLog());
        await expect(client.request("events/subscribe", { name: "alarm", arguments: {}, delivery: { mode: "webhook", url: "https://x", secret: "whsec_x" } })).rejects.toThrow(
            /-32026/
        );
    });
});

describe("events over stateless Streamable HTTP", () => {
    let server: Server | undefined;
    let endpoint: StreamableHttpEndpoint | undefined;
    afterEach(async () => {
        await endpoint?.closeAll();
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        server = undefined;
        endpoint = undefined;
    });

    it("streams occurrences on the request's own SSE response, with Mcp-Name set", async () => {
        // One log shared by every per-request server; one extension per server.
        const log = alarmLog();
        endpoint = new StreamableHttpEndpoint({
            createServer: (transport) => new McpServerBuilder().withName("plant").withTransport(transport).withExtension(new McpEventsExtension(log)).build(),
        });
        server = createServer((req, res) => void endpoint!.handleRequest(req, res));
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

        const client = new McpClient({ name: "c", version: "1" }, new StreamableHttpTransport(url), 5_000, { protocol: "stateless" });
        await client.connect();
        const events = new McpEventsClient(client);
        const seen: string[] = [];
        const stream = events.stream("alarm", {}, { onEvent: (e) => seen.push(String(e.data["tag"])) }, { heartbeatMs: 5_000 });
        await settle(100);
        log.publish("alarm", { area: "nord", tag: "over-http" });
        await settle(100);
        expect(seen).toEqual(["over-http"]);
        const polled = await events.poll("alarm", {}, "0");
        expect(polled.events.map((e) => e.data["tag"])).toEqual(["over-http"]);
        stream.close();
        client.disconnect();
    });
});
