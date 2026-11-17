import { describe, expect, it } from "vitest";
import { appsClientCapabilities, LoopbackTransport, MCP_META, McpAppsExtension, McpClient, McpServer, McpServerBuilder, McpToolResults, withUi } from "../src";
import type { IMcpBehavior, IMcpRequestContext, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

/**
 * Protocol revision 2026-07-28: requests carry their revision and the client's
 * capabilities in `_meta`, with no `initialize`. The same server keeps serving
 * handshake clients.
 */

const V = "2026-07-28";

/** A behavior with one tool, one resource, and a tool that asks for input. */
class PlantBehavior implements IMcpBehavior {
    readonly namespace: string;
    lastRequest: IMcpRequestContext | undefined;

    constructor(namespace = "plant") {
        this.namespace = namespace;
    }
    getResources(): McpResource[] {
        return [{ uri: `${this.namespace}://gauge`, name: "gauge" }];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [
            { name: `${this.namespace}_read`, inputSchema: { type: "object" } },
            { name: `${this.namespace}_confirm`, inputSchema: { type: "object" } },
        ];
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return uri === `${this.namespace}://gauge` ? { uri, text: "42" } : undefined;
    }
    async executeToolAsync(_uri: string, tool: string, _args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        this.lastRequest = request;
        request?.log?.("info", { tool });
        if (tool.endsWith("_confirm") && !request?.inputResponses?.["ok"]) {
            return McpToolResults.inputRequired({
                inputRequests: { ok: { method: "elicitation/create", params: { message: "Sure?", requestedSchema: { type: "object", properties: {} } } } },
            });
        }
        return { content: [{ type: "text", text: "done" }] };
    }
}

interface IFrame {
    jsonrpc: "2.0";
    id?: string | number;
    method?: string;
    params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
    result?: Record<string, unknown> & { _meta?: Record<string, unknown> };
    error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** A server over a loopback pair, with the client end driven by hand. */
async function rawServer(options: { logging?: boolean; extensions?: McpAppsExtension[] } = {}) {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const behavior = new PlantBehavior();
    let builder = new McpServerBuilder().withName("plant-server").withTransport(serverEnd).withOptions({ logging: options.logging }).register(behavior);
    for (const extension of options.extensions ?? []) builder = builder.withExtension(extension);
    const server = builder.build() as McpServer;
    await server.start();
    const frames: IFrame[] = [];
    clientEnd.onMessage = (data) => frames.push(JSON.parse(data) as IFrame);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    const meta = (extra: Record<string, unknown> = {}) => ({
        [MCP_META.protocolVersion]: V,
        [MCP_META.clientCapabilities]: {},
        [MCP_META.clientInfo]: { name: "modern", version: "1" },
        ...extra,
    });
    let nextId = 1;
    const send = async (method: string, params: Record<string, unknown> = {}, metaExtra: Record<string, unknown> = {}, id: number = nextId++) => {
        clientEnd.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta(metaExtra) } }));
        await settle();
        return frames.find((frame) => frame.id === id && frame.method === undefined);
    };
    return { server, behavior, clientEnd, frames, send, settle, meta };
}

describe("stateless requests (2026-07-28)", () => {
    it("answers server/discover with versions, capabilities, identity and caching hints", async () => {
        const { send } = await rawServer();
        const response = await send("server/discover");
        expect(response?.result).toMatchObject({
            resultType: "complete",
            supportedVersions: [V],
            capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
            ttlMs: 0,
            cacheScope: "private",
        });
        expect(response?.result?._meta?.[MCP_META.serverInfo]).toEqual({ name: "plant-server", version: "0.0.0" });
    });

    it("serves the ordinary methods with no initialize, and decorates their results", async () => {
        const { send } = await rawServer();
        const tools = await send("tools/list");
        expect(tools?.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
        expect((tools?.result?.["tools"] as McpTool[]).map((tool) => tool.name)).toEqual(["plant_read", "plant_confirm"]);
        const call = await send("tools/call", { name: "plant_read", arguments: {} });
        expect(call?.result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: "done" }] });
        expect(call?.result?.["ttlMs"]).toBeUndefined();
    });

    it("refuses an unknown revision with -32022 and a request without capabilities with -32602", async () => {
        const { send } = await rawServer();
        const old = await send("tools/list", {}, { [MCP_META.protocolVersion]: "2025-11-25" });
        expect(old?.error).toEqual({ code: -32022, message: "Unsupported protocol version: 2025-11-25", data: { supported: [V], requested: "2025-11-25" } });
        const bare = await send("tools/list", {}, { [MCP_META.clientCapabilities]: undefined });
        expect(bare?.error?.code).toBe(-32602);
    });

    it("answers -32601 to the methods 2026-07-28 removed, and -32602 to a missing resource", async () => {
        const { send } = await rawServer();
        expect((await send("ping"))?.error?.code).toBe(-32601);
        expect((await send("resources/subscribe", { uri: "plant://gauge" }))?.error?.code).toBe(-32601);
        expect((await send("logging/setLevel", { level: "debug" }))?.error?.code).toBe(-32601);
        const missing = await send("resources/read", { uri: "plant://nothing" });
        expect(missing?.error).toMatchObject({ code: -32602, data: { uri: "plant://nothing" } });
    });

    it("hands the request's own client view to the behavior", async () => {
        const { send, behavior } = await rawServer();
        await send("tools/call", { name: "plant_read", arguments: {} }, { [MCP_META.clientCapabilities]: { elicitation: {} } });
        expect(behavior.lastRequest).toMatchObject({ stateless: true, protocolVersion: V, clientCapabilities: { elicitation: {} }, clientInfo: { name: "modern", version: "1" } });
    });

    it("passes a multi round-trip answer through, and carries the retry's responses", async () => {
        const { send } = await rawServer();
        const first = await send("tools/call", { name: "plant_confirm", arguments: {} });
        expect(first?.result).toMatchObject({ resultType: "input_required", inputRequests: { ok: { method: "elicitation/create" } } });
        expect(first?.result?.["ttlMs"]).toBeUndefined();
        const retry = await send("tools/call", { name: "plant_confirm", arguments: {}, inputResponses: { ok: { action: "accept" } } });
        expect(retry?.result).toMatchObject({ resultType: "complete" });
    });

    it("logs only for a request that asked, at or above its level", async () => {
        const { send, frames } = await rawServer({ logging: true });
        await send("tools/call", { name: "plant_read", arguments: {} });
        expect(frames.filter((frame) => frame.method === "notifications/message")).toHaveLength(0);
        await send("tools/call", { name: "plant_read", arguments: {} }, { [MCP_META.logLevel]: "warning" });
        expect(frames.filter((frame) => frame.method === "notifications/message")).toHaveLength(0);
        await send("tools/call", { name: "plant_read", arguments: {} }, { [MCP_META.logLevel]: "info" });
        expect(frames.filter((frame) => frame.method === "notifications/message")).toHaveLength(1);
        expect((await send("tools/list", {}, { [MCP_META.logLevel]: "loud" }))?.error?.code).toBe(-32602);
    });

    it("adapts tools/list to the capabilities each request declares", async () => {
        class UiBehavior extends PlantBehavior {
            override getTools(): McpTool[] {
                return [withUi({ name: "faceplate", inputSchema: { type: "object" } }, { resourceUri: "ui://plant/faceplate" })];
            }
        }
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        const server = new McpServerBuilder()
            .withTransport(serverEnd)
            .withExtension(new McpAppsExtension({ behaviors: [new UiBehavior("ui")] }))
            .build();
        await server.start();
        const frames: IFrame[] = [];
        clientEnd.onMessage = (data) => frames.push(JSON.parse(data) as IFrame);
        const list = async (id: number, capabilities: object) => {
            clientEnd.send(
                JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: { [MCP_META.protocolVersion]: V, [MCP_META.clientCapabilities]: capabilities } } })
            );
            await new Promise((resolve) => setTimeout(resolve, 5));
            return frames.find((frame) => frame.id === id)?.result?.["tools"] as McpTool[];
        };
        expect((await list(1, appsClientCapabilities()))[0]?._meta?.["ui"]).toBeDefined();
        expect((await list(2, {}))[0]?._meta?.["ui"]).toBeUndefined();
    });
});

describe("subscriptions/listen", () => {
    it("acknowledges the subset it honors first, then delivers tagged notifications until cancelled", async () => {
        const { server, send, frames, clientEnd, settle } = await rawServer();
        void send(
            "subscriptions/listen",
            { notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ["plant://gauge", "plant://nope"] } },
            {},
            50
        );
        await settle();
        const ack = frames.find((frame) => frame.method === "notifications/subscriptions/acknowledged");
        // No prompts on this server: that part is not honored. An unreadable URI is dropped.
        expect(ack?.params).toEqual({ notifications: { toolsListChanged: true, resourceSubscriptions: ["plant://gauge"] }, _meta: { [MCP_META.subscriptionId]: 50 } });

        server.register(new PlantBehavior("more"));
        server.notifyResourceUpdated("plant://gauge");
        server.notifyResourceUpdated("plant://other");
        await settle();
        const tagged = frames.filter((frame) => frame.params?._meta?.[MCP_META.subscriptionId] === 50).map((frame) => frame.method);
        expect(tagged).toEqual(["notifications/subscriptions/acknowledged", "notifications/tools/list_changed", "notifications/resources/updated"]);
        // Nothing untagged: the stateless client has no session to receive it.
        expect(frames.filter((frame) => frame.method?.startsWith("notifications/") && frame.params?._meta?.[MCP_META.subscriptionId] === undefined)).toEqual([]);

        clientEnd.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 } }));
        await settle();
        server.register(new PlantBehavior("again"));
        await settle();
        expect(frames.filter((frame) => frame.method === "notifications/tools/list_changed")).toHaveLength(1);
        expect(frames.find((frame) => frame.id === 50)).toBeUndefined();
    });

    it("answers an open listen when the server stops", async () => {
        const { server, send, frames, settle } = await rawServer();
        void send("subscriptions/listen", { notifications: { toolsListChanged: true } }, {}, 70);
        await settle();
        await server.stop();
        await settle();
        expect(frames.find((frame) => frame.id === 70)?.result).toEqual({ resultType: "complete", _meta: { [MCP_META.subscriptionId]: 70 } });
    });
});

describe("both eras on one server", () => {
    it("keeps a handshake session working beside stateless requests, each with its own notifications", async () => {
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        const server = new McpServerBuilder().withTransport(serverEnd).register(new PlantBehavior()).build() as McpServer;
        await server.start();
        const client = new McpClient({ name: "legacy", version: "1" }, clientEnd);
        const changes: number[] = [];
        client.onToolsChanged?.subscribe(() => changes.push(1));
        await client.connect();
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["plant_read", "plant_confirm"]);
        const stateless = await client.request<Record<string, unknown>>("tools/list", { _meta: { [MCP_META.protocolVersion]: V, [MCP_META.clientCapabilities]: {} } });
        expect(stateless["resultType"]).toBe("complete");
        // A handshake request is not decorated, and a multi round-trip answer is refused to it.
        const legacy = await client.request<Record<string, unknown>>("tools/list");
        expect(legacy["resultType"]).toBeUndefined();
        await expect(client.request("tools/call", { name: "plant_confirm", arguments: {} })).rejects.toThrow(/-32603.*2026-07-28/);

        server.register(new PlantBehavior("more"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(changes).toEqual([1]);
        expect(server.protocolVersion).toBe("2025-11-25");
    });
});

describe("McpClient in the stateless era", () => {
    async function pair(clientOptions: ConstructorParameters<typeof McpClient>[3], serverOptions: { statelessProtocolVersions?: string[]; logging?: boolean } = {}) {
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        const behavior = new PlantBehavior();
        const server = new McpServerBuilder().withName("plant-server").withTransport(serverEnd).withOptions(serverOptions).register(behavior).build() as McpServer;
        await server.start();
        const client = new McpClient({ name: "c", version: "1" }, clientEnd, 2_000, clientOptions);
        return { server, client, behavior };
    }

    it("connects with server/discover, sends no initialize, and stamps every request", async () => {
        const { server, client, behavior } = await pair({ protocol: "stateless" });
        const opened = await client.connect();
        expect(client.isStateless).toBe(true);
        expect(opened.protocolVersion).toBe(V);
        expect(opened.serverInfo).toEqual({ name: "plant-server", version: "0.0.0" });
        expect(server.protocolVersion).toBeUndefined();
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["plant_read", "plant_confirm"]);
        await client.callTool("plant_read", {});
        expect(behavior.lastRequest?.stateless).toBe(true);
        await client.ping();
    });

    it("receives list changes and resource updates through its own listen", async () => {
        const { server, client } = await pair({ protocol: "stateless" });
        await client.connect();
        const changes: string[] = [];
        client.onToolsChanged?.subscribe(() => changes.push("tools"));
        client.onResourceUpdated?.subscribe((uri) => changes.push(uri));
        await client.subscribeResource("plant://gauge");
        await expect(client.subscribeResource("plant://none")).rejects.toThrow(/did not accept/);
        server.register(new PlantBehavior("more"));
        server.notifyResourceUpdated("plant://gauge");
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(changes).toEqual(["tools", "plant://gauge"]);
        await client.unsubscribeResource("plant://gauge");
        server.notifyResourceUpdated("plant://gauge");
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(changes).toEqual(["tools", "plant://gauge"]);
    });

    it("asks for log messages per request once a level is set", async () => {
        const { client } = await pair({ protocol: "stateless" }, { logging: true });
        await client.connect();
        const messages: unknown[] = [];
        client.onNotification.subscribe((message) => message.method === "notifications/message" && messages.push(message.params));
        await client.callTool("plant_read", {});
        expect(messages).toHaveLength(0);
        await client.setLoggingLevel("info");
        await client.callTool("plant_read", {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(messages).toHaveLength(1);
    });

    it("auto: speaks stateless to a modern server and falls back to initialize with an older one", async () => {
        const modern = await pair({ protocol: "auto" });
        await modern.client.connect();
        expect(modern.client.isStateless).toBe(true);

        const older = await pair({ protocol: "auto" }, { statelessProtocolVersions: [] });
        const opened = await older.client.connect();
        expect(older.client.isStateless).toBe(false);
        expect(opened.protocolVersion).toBe("2025-11-25");
        expect(older.server.protocolVersion).toBe("2025-11-25");
    });

    it("stateless only: refuses a server that does not answer server/discover", async () => {
        const older = await pair({ protocol: "stateless" }, { statelessProtocolVersions: [] });
        await expect(older.client.connect()).rejects.toThrow(/-32601/);
    });
});
