import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MCP_META, McpClient, McpServer, McpServerBuilder } from "../src";
import { decodeMcpHeaderValue, encodeMcpHeaderValue, StreamableHttpEndpoint, StreamableHttpTransport } from "../src/node";
import type { IMcpBehavior, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

/** Streamable HTTP for revision 2026-07-28: POST only, no session, headers mirroring the body. */

const V = "2026-07-28";

class GaugeBehavior implements IMcpBehavior {
    readonly namespace = "gauge";
    getResources(): McpResource[] {
        return [{ uri: "gauge://pressure", name: "pressure" }];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [{ name: "réglage", inputSchema: { type: "object" } }];
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return uri === "gauge://pressure" ? { uri, text: "3 bar" } : undefined;
    }
    async executeToolAsync(_uri: string, tool: string): Promise<McpToolResult> {
        return { content: [{ type: "text", text: `ran ${tool}` }] };
    }
}

let server: Server | undefined;
let endpoint: StreamableHttpEndpoint | undefined;
const built: McpServer[] = [];

afterEach(async () => {
    await endpoint?.closeAll();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    endpoint = undefined;
    built.length = 0;
});

async function start(): Promise<string> {
    endpoint = new StreamableHttpEndpoint({
        createServer: (transport) => {
            const s = new McpServerBuilder().withName("gauges").withTransport(transport).register(new GaugeBehavior()).build() as McpServer;
            built.push(s);
            return s;
        },
    });
    server = createServer((req, res) => void endpoint!.handleRequest(req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function post(url: string, body: object, headers: Record<string, string>): Promise<Response> {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
}

const meta = { [MCP_META.protocolVersion]: V, [MCP_META.clientCapabilities]: {} };

describe("Mcp header values", () => {
    it("round-trips non-ASCII and sentinel-looking values through base64, leaves plain ASCII as is", () => {
        expect(encodeMcpHeaderValue("tools_read")).toBe("tools_read");
        expect(encodeMcpHeaderValue("réglage")).toMatch(/^=\?base64\?.+\?=$/);
        expect(decodeMcpHeaderValue(encodeMcpHeaderValue("réglage"))).toBe("réglage");
        expect(decodeMcpHeaderValue(encodeMcpHeaderValue("=?base64?x?="))).toBe("=?base64?x?=");
        expect(encodeMcpHeaderValue(" padded")).toMatch(/^=\?base64\?/);
    });
});

describe("StreamableHttpEndpoint, stateless requests", () => {
    it("answers a request without a session, as JSON, with no session id", async () => {
        const url = await start();
        const response = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }, { "mcp-protocol-version": V, "mcp-method": "tools/list" });
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
        const body = (await response.json()) as { result: { resultType: string; tools: McpTool[] } };
        expect(body.result.resultType).toBe("complete");
        expect(body.result.tools[0].name).toBe("réglage");
        expect(endpoint!.sessionCount).toBe(0);
    });

    it("refuses headers that contradict the body with 400 and -32020", async () => {
        const url = await start();
        const noMethod = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }, { "mcp-protocol-version": V });
        expect(noMethod.status).toBe(400);
        expect(((await noMethod.json()) as { error: { code: number } }).error.code).toBe(-32020);
        const wrongVersion = await post(
            url,
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } },
            { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" }
        );
        expect(((await wrongVersion.json()) as { error: { code: number } }).error.code).toBe(-32020);
        const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "réglage", arguments: {}, _meta: meta } };
        const noName = await post(url, call, { "mcp-protocol-version": V, "mcp-method": "tools/call" });
        expect(((await noName.json()) as { error: { code: number } }).error.code).toBe(-32020);
        const named = await post(url, call, { "mcp-protocol-version": V, "mcp-method": "tools/call", "mcp-name": encodeMcpHeaderValue("réglage") });
        expect(((await named.json()) as { result: { content: { text: string }[] } }).result.content[0].text).toBe("ran réglage");
    });

    it("answers an unknown or removed method with 404 and -32601", async () => {
        const url = await start();
        const response = await post(url, { jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: meta } }, { "mcp-protocol-version": V, "mcp-method": "ping" });
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32601);
    });

    it("keeps serving handshake sessions on the same URL", async () => {
        const url = await start();
        const client = new McpClient({ name: "legacy", version: "1" }, new StreamableHttpTransport(url));
        await client.connect();
        expect(client.isStateless).toBe(false);
        expect(endpoint!.sessionCount).toBe(1);
        client.disconnect();
    });
});

describe("McpClient over stateless Streamable HTTP", () => {
    it("connects, lists, calls a non-ASCII tool and reads, with no session", async () => {
        const url = await start();
        const client = new McpClient({ name: "modern", version: "1" }, new StreamableHttpTransport(url), 5_000, { protocol: "auto" });
        const opened = await client.connect();
        expect(client.isStateless).toBe(true);
        expect(opened.serverInfo.name).toBe("gauges");
        expect((await client.callTool("réglage", {})).content[0]).toEqual({ type: "text", text: "ran réglage" });
        expect((await client.readResource("gauge://pressure")).text).toBe("3 bar");
        expect(endpoint!.sessionCount).toBe(0);
        client.disconnect();
    });

    it("receives resource updates on its listen stream, and stops them by closing it", async () => {
        const url = await start();
        const client = new McpClient({ name: "modern", version: "1" }, new StreamableHttpTransport(url), 5_000, { protocol: "stateless" });
        await client.connect();
        const updates: string[] = [];
        client.onResourceUpdated?.subscribe((uri) => updates.push(uri));
        await client.subscribeResource("gauge://pressure");
        // The listen's server is the most recent one built.
        const listening = built[built.length - 1];
        listening.notifyResourceUpdated("gauge://pressure");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(updates).toEqual(["gauge://pressure"]);

        client.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(listening.notifyResourceUpdated("gauge://pressure")).toBe(false);
    });
});
