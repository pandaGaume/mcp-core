import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpClient } from "../src/client/mcp.client";
import { StreamableHttpTransport } from "../src/node/streamable-http.transport";

// ---------------------------------------------------------------------------
// Test harness: a real HTTP server so the transport exercises real sockets
// ---------------------------------------------------------------------------

interface RecordedRequest {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

interface TestServer {
    url: string;
    requests: RecordedRequest[];
    stop(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, context: { requests: RecordedRequest[] }) => void;

async function startServer(handler: Handler): Promise<TestServer> {
    const requests: RecordedRequest[] = [];

    const server: Server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            body += chunk;
        });
        req.on("end", () => {
            requests.push({ method: req.method ?? "", headers: req.headers, body });
            handler(req, res, { requests });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        requests,
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** Polls until `predicate` holds, so tests never race a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens the transport and resolves once `onOpen` fired. */
function open(transport: StreamableHttpTransport): Promise<void> {
    return new Promise<void>((resolve) => {
        transport.onOpen = () => resolve();
        transport.connect();
    });
}

function jsonResponse(res: ServerResponse, payload: unknown, sessionId?: string): void {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    res.writeHead(200, headers);
    res.end(JSON.stringify(payload));
}

const initResult = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } };

// ---------------------------------------------------------------------------

describe("StreamableHttpTransport", () => {
    let server: TestServer | undefined;
    let transport: StreamableHttpTransport | undefined;

    afterEach(async () => {
        transport?.close();
        transport = undefined;
        await server?.stop();
        server = undefined;
    });

    // ── Headers ──────────────────────────────────────────────────────────

    it("posts with both accepted content types and no version header before negotiation", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult));
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => server!.requests.length === 1);

        const post = server.requests[0];
        expect(post.method).toBe("POST");
        expect(post.headers["accept"]).toContain("application/json");
        expect(post.headers["accept"]).toContain("text/event-stream");
        expect(post.headers["mcp-protocol-version"]).toBeUndefined();
    });

    it("stamps the negotiated revision on every later request", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult));
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });

        await open(transport);
        transport.setProtocolVersion("2025-11-25");
        transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        await waitFor(() => server!.requests.length === 1);

        expect(server.requests[0].headers["mcp-protocol-version"]).toBe("2025-11-25");
    });

    it("re-reads a header function on every request, so a rotated token takes effect", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult));

        let token = "first";
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false, headers: () => ({ Authorization: `Bearer ${token}` }) });

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => server!.requests.length === 1);

        token = "rotated";
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        await waitFor(() => server!.requests.length === 2);

        expect(server.requests[0].headers["authorization"]).toBe("Bearer first");
        expect(server.requests[1].headers["authorization"]).toBe("Bearer rotated");
    });

    it("snapshots a plain header object, so later mutation of the caller's copy is ignored", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult));

        const headers = { Authorization: "Bearer static" };
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false, headers });

        await open(transport);
        headers.Authorization = "Bearer mutated";
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => server!.requests.length === 1);

        expect(server.requests[0].headers["authorization"]).toBe("Bearer static");
    });

    // ── Session ──────────────────────────────────────────────────────────

    it("captures the session id and echoes it on later requests", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult, "sess-1"));
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => transport!.sessionId === "sess-1");

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        await waitFor(() => server!.requests.length === 2);

        expect(server.requests[0].headers["mcp-session-id"]).toBeUndefined();
        expect(server.requests[1].headers["mcp-session-id"]).toBe("sess-1");
    });

    it("terminates the session with an HTTP DELETE on close", async () => {
        server = await startServer((_req, res) => jsonResponse(res, initResult, "sess-1"));
        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => transport!.sessionId === "sess-1");

        transport.close();
        await waitFor(() => server!.requests.some((r) => r.method === "DELETE"));

        const del = server.requests.find((r) => r.method === "DELETE");
        expect(del?.headers["mcp-session-id"]).toBe("sess-1");
    });

    it("treats a 404 on a live session as a close so the client can re-initialize", async () => {
        let calls = 0;
        server = await startServer((_req, res) => {
            calls++;
            if (calls === 1) return jsonResponse(res, initResult, "sess-1");
            res.writeHead(404).end();
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const events: string[] = [];
        transport.onError = () => events.push("error");
        transport.onClose = () => events.push("close");

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => transport!.sessionId === "sess-1");

        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        await waitFor(() => events.includes("close"));

        expect(events).toEqual(["error", "close"]);
        expect(transport.sessionId).toBeNull();
        expect(transport.isOpen).toBe(false);

        // The transport is reusable: a fresh connect() must start a new session.
        await open(transport);
        expect(transport.isOpen).toBe(true);
    });

    // ── SSE ──────────────────────────────────────────────────────────────

    it("delivers messages from an SSE POST response", async () => {
        server = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
            res.write(`data: ${JSON.stringify(initResult)}\n\n`);
            res.end();
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const messages: string[] = [];
        transport.onMessage = (data) => messages.push(data);

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => messages.length === 2);

        expect(JSON.parse(messages[0]).method).toBe("notifications/tools/list_changed");
        expect(JSON.parse(messages[1]).id).toBe(1);
    });

    // ── Standalone GET stream ────────────────────────────────────────────

    it("opens the GET stream even when the server runs stateless", async () => {
        server = await startServer((req, res) => {
            if (req.method === "GET") {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                return;
            }
            jsonResponse(res, initResult); // no Mcp-Session-Id
        });

        transport = new StreamableHttpTransport(server.url);
        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
        await waitFor(() => server!.requests.some((r) => r.method === "GET"));

        const get = server.requests.find((r) => r.method === "GET");
        expect(transport.sessionId).toBeNull();
        expect(get?.headers["accept"]).toBe("text/event-stream");
    });

    it("resumes a closed GET stream with Last-Event-ID and honours the retry delay", async () => {
        server = await startServer((req, res) => {
            if (req.method !== "GET") return jsonResponse(res, initResult, "sess-1");
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write("retry: 20\n\n");
            res.write(`id: evt-7\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
            res.end();
        });

        // A base delay far above the server's `retry` proves the field is honoured.
        transport = new StreamableHttpTransport(server.url, { reconnectDelayMs: 30_000 });
        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));

        await waitFor(() => server!.requests.filter((r) => r.method === "GET").length >= 2);

        const gets = server.requests.filter((r) => r.method === "GET");
        expect(gets[0].headers["last-event-id"]).toBeUndefined();
        expect(gets[1].headers["last-event-id"]).toBe("evt-7");
    });

    it("survives a GET stream the server drops mid-flight and reconnects", async () => {
        server = await startServer((req, res) => {
            if (req.method !== "GET") return jsonResponse(res, initResult, "sess-1");
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write("retry: 20\n\n");
            res.write("id: evt-9\ndata: {}\n\n");
            // Kill the socket rather than ending the stream: the response emits
            // an error, which must not escape as an uncaught exception. Let the
            // writes reach the wire first, since destroy() discards buffers.
            setTimeout(() => res.destroy(), 30);
        });

        transport = new StreamableHttpTransport(server.url, { reconnectDelayMs: 30_000 });
        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));

        await waitFor(() => server!.requests.filter((r) => r.method === "GET").length >= 2);
        expect(server.requests.filter((r) => r.method === "GET")[1].headers["last-event-id"]).toBe("evt-9");
    });

    // ── HTTP failures ────────────────────────────────────────────────────

    it("fails the pending request when the server answers an HTTP error", async () => {
        server = await startServer((_req, res) => {
            res.writeHead(500, { "Content-Type": "text/plain" }).end("upstream exploded");
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const messages: string[] = [];
        const errors: string[] = [];
        transport.onMessage = (data) => messages.push(data);
        transport.onError = (error) => errors.push(error.message);

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list" }));
        await waitFor(() => messages.length === 1);

        const failure = JSON.parse(messages[0]);
        expect(failure.id).toBe(12);
        expect(failure.error.code).toBe(-32000);
        expect(failure.error.message).toContain("500");
        expect(failure.error.message).toContain("upstream exploded");
        expect(failure.error.data.httpStatus).toBe(500);
        expect(errors).toHaveLength(0);
    });

    it("forwards a JSON-RPC error body as-is, filling in the missing id", async () => {
        server = await startServer((_req, res) => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } }));
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const messages: string[] = [];
        transport.onMessage = (data) => messages.push(data);

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "tools/list" }));
        await waitFor(() => messages.length === 1);

        const failure = JSON.parse(messages[0]);
        expect(failure.id).toBe("abc");
        expect(failure.error.code).toBe(-32600);
    });

    it("reports an HTTP error on a notification through onError, since nothing is pending", async () => {
        server = await startServer((_req, res) => {
            res.writeHead(400).end();
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const messages: string[] = [];
        const errors: string[] = [];
        transport.onMessage = (data) => messages.push(data);
        transport.onError = (error) => errors.push(error.message);

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        await waitFor(() => errors.length === 1);

        expect(errors[0]).toContain("400");
        expect(messages).toHaveLength(0);
    });

    it("does not let a non-JSON 200 body vanish", async () => {
        server = await startServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/html" }).end("<html>gateway</html>");
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const messages: string[] = [];
        transport.onMessage = (data) => messages.push(data);

        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
        await waitFor(() => messages.length === 1);

        const failure = JSON.parse(messages[0]);
        expect(failure.id).toBe(3);
        expect(failure.error.message).toContain("gateway");
    });

    it("rejects an McpClient call promptly instead of waiting out its timeout", async () => {
        server = await startServer((_req, res, { requests }) => {
            if (requests.length === 1)
                return jsonResponse(res, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", serverInfo: { name: "s", version: "1" }, capabilities: {} } });
            res.writeHead(503, { "Content-Type": "text/plain" }).end("unavailable");
        });

        transport = new StreamableHttpTransport(server.url, { enableGetStream: false });
        const client = new McpClient({ name: "c", version: "1.0.0" }, transport, 30_000);
        await client.connect();

        await expect(client.listTools()).rejects.toThrow(/503/);
    });

    it("stops retrying the GET stream when the server answers 405", async () => {
        server = await startServer((req, res) => {
            if (req.method !== "GET") return jsonResponse(res, initResult, "sess-1");
            res.writeHead(405).end();
        });

        transport = new StreamableHttpTransport(server.url, { reconnectDelayMs: 10 });
        await open(transport);
        transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));

        await waitFor(() => server!.requests.some((r) => r.method === "GET"));
        await sleep(120);

        expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(1);
    });
});
