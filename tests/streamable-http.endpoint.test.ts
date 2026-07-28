import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpClient, McpServerBuilder, McpToolResults } from "../src";
import { StreamableHttpEndpoint, StreamableHttpTransport } from "../src/node/index";
import { McpAuthError, parseChallengeHeader, type IMcpPrincipal, type ITokenValidator } from "../src/mcp.auth";
import type { IMcpBehavior, IMessageTransport, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const echoTool: McpTool = { name: "echo", description: "Echoes its argument", inputSchema: { type: "object", properties: { text: { type: "string" } } } };

class EchoBehavior implements IMcpBehavior {
    readonly namespace = "echo";

    getResources(): McpResource[] {
        return [];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [echoTool];
    }
    async readResourceAsync(): Promise<McpResourceContent | undefined> {
        return undefined;
    }
    async executeToolAsync(_uri: string, _tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return McpToolResults.text(String(args.text ?? ""));
    }
}

interface Harness {
    url: string;
    endpoint: StreamableHttpEndpoint;
    stop(): Promise<void>;
}

async function startEndpoint(options: Partial<ConstructorParameters<typeof StreamableHttpEndpoint>[0]> = {}): Promise<Harness> {
    const endpoint = new StreamableHttpEndpoint({
        createServer: (transport) => new McpServerBuilder().withName("test-app").withTransport(transport).register(new EchoBehavior()).build(),
        ...options,
    });

    const server: Server = createServer((req, res) => void endpoint.handleRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        endpoint,
        stop: async () => {
            await endpoint.closeAll();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

let harness: Harness | undefined;

afterEach(async () => {
    await harness?.stop();
    harness = undefined;
});

function rpc(id: number, method: string, params?: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INIT = rpc(1, "initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "c", version: "1.0.0" }, capabilities: {} });

// ---------------------------------------------------------------------------
// The pair: this package's own client against this package's own server
// ---------------------------------------------------------------------------

describe("client and endpoint together", () => {
    it("completes a handshake and calls a tool over HTTP", async () => {
        harness = await startEndpoint();

        const client = new McpClient({ name: "agent", version: "1.0.0" }, new StreamableHttpTransport(harness.url));
        const init = await client.connect();
        expect(init.serverInfo.name).toBe("test-app");
        expect(init.protocolVersion).toBe("2025-11-25");

        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["echo"]);

        const result = await client.callTool("echo", { text: "hello" });
        expect(result.content[0]).toEqual({ type: "text", text: "hello" });

        client.disconnect();
    });

    it("keeps two clients on separate sessions", async () => {
        harness = await startEndpoint();

        const first = new McpClient({ name: "a", version: "1.0.0" }, new StreamableHttpTransport(harness.url));
        const second = new McpClient({ name: "b", version: "1.0.0" }, new StreamableHttpTransport(harness.url));
        await first.connect();
        await second.connect();

        expect(harness.endpoint.sessionCount).toBe(2);
        expect((await first.listTools()).length).toBe(1);
        expect((await second.listTools()).length).toBe(1);

        first.disconnect();
        second.disconnect();
    });

    it("delivers a server-initiated message over the standalone GET stream", async () => {
        // The GET stream is the only route for anything the server says on its
        // own, since no POST is waiting to carry it.
        let sessionTransport: IMessageTransport | undefined;
        harness = await startEndpoint({
            createServer: (transport) => {
                sessionTransport = transport;
                return new McpServerBuilder().withName("test-app").withTransport(transport).register(new EchoBehavior()).build();
            },
        });

        const client = new McpClient({ name: "agent", version: "1.0.0" }, new StreamableHttpTransport(harness.url));
        await client.connect();

        const notified = new Promise<void>((resolve) => client.onToolsChanged?.subscribe(() => resolve()));
        // Wait for the client's GET stream to be attached before speaking.
        await waitFor(() => harness!.endpoint.sessionCount === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));

        sessionTransport!.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
        await notified;

        client.disconnect();
    });
});

/** Polls until `predicate` holds. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

// ---------------------------------------------------------------------------
// Protocol-level behaviour, driven with raw fetch
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
    it("assigns a session id on the initialize response and requires it afterwards", async () => {
        harness = await startEndpoint();

        const init = await fetch(harness.url, { method: "POST", body: INIT });
        expect(init.status).toBe(200);
        const sessionId = init.headers.get("mcp-session-id");
        expect(sessionId).toBeTruthy();

        const without = await fetch(harness.url, { method: "POST", body: rpc(2, "tools/list") });
        expect(without.status).toBe(400);

        const with_ = await fetch(harness.url, { method: "POST", headers: { "mcp-session-id": sessionId! }, body: rpc(2, "tools/list") });
        expect(with_.status).toBe(200);
    });

    it("answers 404 once the session is deleted, which is the client's cue to re-initialize", async () => {
        harness = await startEndpoint();

        const init = await fetch(harness.url, { method: "POST", body: INIT });
        const sessionId = init.headers.get("mcp-session-id")!;

        const deleted = await fetch(harness.url, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
        expect(deleted.status).toBe(204);
        expect(harness.endpoint.sessionCount).toBe(0);

        const after = await fetch(harness.url, { method: "POST", headers: { "mcp-session-id": sessionId }, body: rpc(2, "tools/list") });
        expect(after.status).toBe(404);
    });

    it("acknowledges a notification with 202 and no body", async () => {
        harness = await startEndpoint();

        const init = await fetch(harness.url, { method: "POST", body: INIT });
        const sessionId = init.headers.get("mcp-session-id")!;

        const res = await fetch(harness.url, {
            method: "POST",
            headers: { "mcp-session-id": sessionId },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        expect(res.status).toBe(202);
        expect(await res.text()).toBe("");
    });
});

describe("guards", () => {
    it("refuses an unknown Origin with 403, and allows a configured one", async () => {
        harness = await startEndpoint({ allowedOrigins: ["https://trusted.example"] });

        const denied = await fetch(harness.url, { method: "POST", headers: { origin: "https://evil.example" }, body: INIT });
        expect(denied.status).toBe(403);

        const allowed = await fetch(harness.url, { method: "POST", headers: { origin: "https://trusted.example" }, body: INIT });
        expect(allowed.status).toBe(200);
    });

    it("allows a request with no Origin, since it cannot be a browser", async () => {
        harness = await startEndpoint({ allowedOrigins: [] });
        expect((await fetch(harness.url, { method: "POST", body: INIT })).status).toBe(200);
    });

    it("refuses an unsupported MCP-Protocol-Version with 400", async () => {
        harness = await startEndpoint();
        const res = await fetch(harness.url, { method: "POST", headers: { "mcp-protocol-version": "1999-01-01" }, body: INIT });
        expect(res.status).toBe(400);
    });

    it("refuses a JSON-RPC batch, removed from MCP in 2025-06-18", async () => {
        harness = await startEndpoint();
        const res = await fetch(harness.url, { method: "POST", body: "[]" });
        expect(res.status).toBe(400);
    });

    it("reports an unsupported method with 405 and an Allow header", async () => {
        harness = await startEndpoint();
        const res = await fetch(harness.url, { method: "PUT", body: "{}" });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toContain("POST");
    });
});

// ---------------------------------------------------------------------------
// OAuth 2.1 resource server
// ---------------------------------------------------------------------------

const RESOURCE = "https://mcp.test/mcp";
const METADATA_URL = "https://mcp.test/.well-known/oauth-protected-resource/mcp";

/** Accepts "good" (with scope) and "noscope"; rejects everything else. */
const validator: ITokenValidator = {
    async validate(token, resource) {
        if (token === "good") return { sub: "u1", aud: resource, scope: "mcp:call" };
        if (token === "noscope") return { sub: "u2", aud: resource };
        throw new McpAuthError(401, "invalid_token", "bad token");
    },
};

const AUTH = { resource: RESOURCE, validator, authorizationServers: ["https://as.test"], metadataUrl: METADATA_URL, scopesSupported: ["mcp:call"], requiredScopes: ["mcp:call"] };

describe("protected resource", () => {
    it("challenges an unauthenticated request with 401 and points at the metadata", async () => {
        harness = await startEndpoint({ auth: AUTH });

        const res = await fetch(harness.url, { method: "POST", body: INIT });
        expect(res.status).toBe(401);

        const challenge = parseChallengeHeader(res.headers.get("www-authenticate"));
        expect(challenge?.resourceMetadata).toBe(METADATA_URL);
        expect(challenge?.error).toBe("invalid_token");
    });

    it("refuses a token missing a required scope with 403 and names the scope", async () => {
        harness = await startEndpoint({ auth: AUTH });

        const res = await fetch(harness.url, { method: "POST", headers: { authorization: "Bearer noscope" }, body: INIT });
        expect(res.status).toBe(403);

        const challenge = parseChallengeHeader(res.headers.get("www-authenticate"));
        expect(challenge?.error).toBe("insufficient_scope");
        expect(challenge?.scope).toBe("mcp:call");
    });

    it("lets a valid token through and hands the principal to the factory", async () => {
        let seen: IMcpPrincipal | undefined;
        harness = await startEndpoint({
            auth: AUTH,
            createServer: (transport, _id, principal) => {
                seen = principal;
                return new McpServerBuilder().withName("test-app").withTransport(transport).register(new EchoBehavior()).build();
            },
        });

        const client = new McpClient({ name: "agent", version: "1.0.0" }, new StreamableHttpTransport(harness.url, { headers: { Authorization: "Bearer good" } }));
        await client.connect();
        expect((await client.listTools()).length).toBe(1);

        expect(seen?.claims.sub).toBe("u1");
        expect(seen?.scopes.has("mcp:call")).toBe(true);

        client.disconnect();
    });

    it("publishes a metadata document naming its resource and authorization server", async () => {
        harness = await startEndpoint({ auth: AUTH });

        expect(harness.endpoint.protectedResourceMetadata()).toEqual({
            resource: RESOURCE,
            authorization_servers: ["https://as.test"],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp:call"],
        });
    });

    it("publishes nothing when the endpoint is not protected", async () => {
        harness = await startEndpoint();
        expect(harness.endpoint.protectedResourceMetadata()).toBeUndefined();
    });
});
