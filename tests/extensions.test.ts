import { describe, expect, it } from "vitest";
import { jsonRpcOk, LoopbackTransport, Mcp, McpClient, McpServer, McpServerBuilder } from "../src";
import type { IMcpExtensionHost, IMcpServerExtension, McpClientCapabilities, McpNotificationMessage } from "../src/interfaces";

/** A minimal extension: one method, one notification, settings that can be switched off. */
class EchoExtension implements IMcpServerExtension {
    readonly id = "com.example/echo";
    declared = true;
    host: IMcpExtensionHost | undefined;
    pings: unknown[] = [];
    detached = false;

    settings() {
        return this.declared ? { loud: true } : undefined;
    }
    readonly methods = {
        "echo/say": (req: { id: string | number; params?: unknown }) => jsonRpcOk(req.id, { said: (req.params as { text?: string })?.text }),
        "echo/fail": () => {
            throw new Error("boom");
        },
    };
    readonly notifications = {
        "notifications/echo/ping": (params: unknown) => {
            this.pings.push(params);
        },
    };
    attach(host: IMcpExtensionHost): void {
        this.host = host;
    }
    detach(): void {
        this.detached = true;
    }
}

async function connected(extension: IMcpServerExtension, capabilities: McpClientCapabilities = {}) {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName("s").withTransport(serverEnd).withExtension(extension).build() as McpServer;
    await server.start();
    const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd, 30_000, { capabilities });
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { server, client };
}

describe("MCP extensions", () => {
    it("declares the extension and serves its methods", async () => {
        const extension = new EchoExtension();
        const { client } = await connected(extension);
        expect(client.serverCapabilities?.extensions?.["com.example/echo"]).toEqual({ loud: true });
        expect(client.serverExtension("com.example/echo")).toEqual({ loud: true });
        expect(client.serverExtension("com.example/other")).toBeUndefined();
        expect(await client.request<{ said: string }>("echo/say", { text: "hi" })).toEqual({ said: "hi" });
    });

    it("answers -32603 when a handler throws, -32601 once the extension is no longer declared", async () => {
        const extension = new EchoExtension();
        const { client } = await connected(extension);
        await expect(client.request("echo/fail")).rejects.toThrow(/-32603.*boom/);
        extension.declared = false;
        await expect(client.request("echo/say", { text: "hi" })).rejects.toThrow(/-32601/);
    });

    it("hands the extension the client's declaration and a way to notify", async () => {
        const extension = new EchoExtension();
        const { client } = await connected(extension, { extensions: { "com.example/echo": { volume: 3 } } });
        expect(extension.host?.clientExtension("com.example/echo")).toEqual({ volume: 3 });
        expect(extension.host?.clientInfo?.name).toBe("c");

        const seen: McpNotificationMessage[] = [];
        client.onNotification.subscribe((message) => seen.push(message));
        expect(extension.host?.notify("notifications/echo/said", { text: "hello" })).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(seen).toEqual([{ method: "notifications/echo/said", params: { text: "hello" } }]);
    });

    it("routes the extension's client notifications", async () => {
        const extension = new EchoExtension();
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        const server = new McpServerBuilder().withTransport(serverEnd).withExtension(extension).build();
        await server.start();
        await new McpClient({ name: "c", version: "1" }, clientEnd).connect();
        clientEnd.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/echo/ping", params: { n: 1 } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(extension.pings).toEqual([{ n: 1 }]);
        await server.stop();
        expect(extension.detached).toBe(true);
    });

    it("refuses core methods, double claims and repeated ids at build", () => {
        const [serverEnd] = LoopbackTransport.createPair();
        const core: IMcpServerExtension = { id: "x/core", settings: () => ({}), methods: { "tools/list": () => Mcp.emptyResult(1) } };
        expect(() => new McpServerBuilder().withTransport(serverEnd).withExtension(core).build()).toThrow(/core method "tools\/list"/);

        const a: IMcpServerExtension = { id: "x/a", settings: () => ({}), methods: { "x/do": () => Mcp.emptyResult(1) } };
        const b: IMcpServerExtension = { id: "x/b", settings: () => ({}), methods: { "x/do": () => Mcp.emptyResult(1) } };
        expect(() => new McpServerBuilder().withTransport(serverEnd).withExtension(a, b).build()).toThrow(/already served by "x\/a"/);
        expect(() =>
            new McpServerBuilder()
                .withTransport(serverEnd)
                .withExtension(a, { ...a })
                .build()
        ).toThrow(/already registered/);

        const coreNote: IMcpServerExtension = { id: "x/n", settings: () => ({}), notifications: { "notifications/cancelled": () => undefined } };
        expect(() => new McpServerBuilder().withTransport(serverEnd).withExtension(coreNote).build()).toThrow(/core notification/);
    });

    it("forgets the client's declaration when the session ends", async () => {
        const extension = new EchoExtension();
        const { server, client } = await connected(extension, { extensions: { "com.example/echo": {} } });
        expect(server.clientExtension("com.example/echo")).toEqual({});
        client.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(server.clientCapabilities).toBeUndefined();
        expect(client.serverCapabilities).toBeUndefined();
    });
});
