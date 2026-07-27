import { describe, it, expect } from "vitest";
import { LoopbackTransport, McpClient, McpServer, McpServerBuilder, MCP_LATEST_PROTOCOL_VERSION, isProtocolVersionSupported, negotiateProtocolVersion } from "../src";
import type { IMcpBehavior, IMessageTransport, JsonRpcRequest, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Hand-rolled behavior so each test controls exactly what it exposes. */
class StubBehavior implements IMcpBehavior {
    constructor(
        public readonly namespace: string,
        private readonly _resources: McpResource[] = [],
        private readonly _tools: McpTool[] = [],
        private readonly _onCall?: () => McpToolResult
    ) {}

    getResources(): McpResource[] {
        return this._resources;
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return this._tools;
    }
    async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return undefined;
    }
    async executeToolAsync(_uri: string, _toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        if (!this._onCall) return { content: [] };
        return this._onCall();
    }
}

const echoTool: McpTool = { name: "echo", description: "echo", inputSchema: { type: "object" } };
const someResource: McpResource = { uri: "app://thing", name: "thing", mimeType: "application/json" };

function initRequest(protocolVersion?: string): JsonRpcRequest {
    return {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, clientInfo: { name: "test", version: "1.0.0" }, capabilities: {} },
    };
}

/**
 * A transport of a class neither the server nor the client knows about, which
 * only advertises `connect()`. Counts how many times it was opened.
 */
class CountingTransport implements IMessageTransport {
    public connectCalls = 0;

    constructor(private readonly _inner: IMessageTransport) {}

    get isOpen(): boolean {
        return this._inner.isOpen;
    }
    get onMessage(): ((data: string) => void) | null {
        return this._inner.onMessage;
    }
    set onMessage(handler: ((data: string) => void) | null) {
        this._inner.onMessage = handler;
    }
    get onOpen(): (() => void) | null {
        return this._inner.onOpen;
    }
    set onOpen(handler: (() => void) | null) {
        this._inner.onOpen = handler;
    }
    get onClose(): (() => void) | null {
        return this._inner.onClose;
    }
    set onClose(handler: (() => void) | null) {
        this._inner.onClose = handler;
    }
    get onError(): ((error: Error) => void) | null {
        return this._inner.onError;
    }
    set onError(handler: ((error: Error) => void) | null) {
        this._inner.onError = handler;
    }

    send(data: string): void {
        this._inner.send(data);
    }
    close(): void {
        this._inner.close();
    }
    connect(): void {
        this.connectCalls++;
        (this._inner as IMessageTransport & { connect(): void }).connect();
    }
}

/** Lets queued microtasks and the loopback delivery hops settle. */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Spins up a server over a loopback pair and returns the free end plus a
 * capture buffer, so a test can push raw JSON-RPC frames at it.
 */
async function rawServer(...behaviors: IMcpBehavior[]): Promise<{ peer: IMessageTransport; received: Record<string, unknown>[] }> {
    const [serverEnd, peer] = LoopbackTransport.createPair();
    const builder = new McpServerBuilder().withName("test-server").withTransport(serverEnd);
    for (const b of behaviors) builder.register(b);
    await builder.build().start();

    const received: Record<string, unknown>[] = [];
    peer.onMessage = (data) => received.push(JSON.parse(data) as Record<string, unknown>);
    return { peer, received };
}

// ---------------------------------------------------------------------------
// Version negotiation — pure helpers
// ---------------------------------------------------------------------------

describe("negotiateProtocolVersion", () => {
    it("echoes a revision it supports", () => {
        expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
        expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
    });

    it("falls back to the latest supported revision", () => {
        expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_LATEST_PROTOCOL_VERSION);
        expect(negotiateProtocolVersion(undefined)).toBe(MCP_LATEST_PROTOCOL_VERSION);
    });

    it("honours a narrowed supported set", () => {
        expect(negotiateProtocolVersion("2025-11-25", ["2024-11-05"])).toBe("2024-11-05");
        expect(negotiateProtocolVersion("2024-11-05", ["2024-11-05"])).toBe("2024-11-05");
    });

    it("reports support membership", () => {
        expect(isProtocolVersionSupported(MCP_LATEST_PROTOCOL_VERSION)).toBe(true);
        expect(isProtocolVersionSupported("1999-01-01")).toBe(false);
        expect(isProtocolVersionSupported(undefined)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Server — initialize
// ---------------------------------------------------------------------------

describe("McpServer.initialize", () => {
    it("echoes the revision the client requested", () => {
        const server = new McpServer("s", {});
        const res = server.initialize(initRequest("2025-06-18"));
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
        expect(server.protocolVersion).toBe("2025-06-18");
    });

    it("answers with its latest revision when the requested one is unknown", () => {
        const server = new McpServer("s", {});
        const res = server.initialize(initRequest("1999-01-01"));
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    });

    it("respects a narrowed set from server options", () => {
        const server = new McpServer("s", { protocolVersions: ["2024-11-05"] });
        const res = server.initialize(initRequest(MCP_LATEST_PROTOCOL_VERSION));
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    });

    it("lets an initializer pin a revision", () => {
        const server = new McpServer("s", {}, { initialize: () => ({ protocolVersion: "2024-11-05", serverInfo: { name: "s", version: "1.0.0" } }) });
        const res = server.initialize(initRequest(MCP_LATEST_PROTOCOL_VERSION));
        expect((res.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    });
});

// ---------------------------------------------------------------------------
// Server — capabilities
// ---------------------------------------------------------------------------

describe("McpServer capabilities", () => {
    function capsOf(...behaviors: IMcpBehavior[]) {
        const server = new McpServer("s", {});
        server.register(...behaviors);
        return (server.initialize(initRequest()).result as { capabilities: Record<string, unknown> }).capabilities;
    }

    it("advertises nothing when no behavior is registered", () => {
        expect(capsOf()).toEqual({});
    });

    it("does not advertise resources for a tools-only behavior", () => {
        const caps = capsOf(new StubBehavior("t", [], [echoTool]));
        expect(caps).toEqual({ tools: { listChanged: true } });
    });

    it("does not advertise tools for a resources-only behavior", () => {
        const caps = capsOf(new StubBehavior("r", [someResource], []));
        expect(caps).toEqual({ resources: { listChanged: true } });
    });

    it("advertises both when both are present", () => {
        const caps = capsOf(new StubBehavior("b", [someResource], [echoTool]));
        expect(caps).toEqual({ resources: { listChanged: true }, tools: { listChanged: true } });
    });
});

// ---------------------------------------------------------------------------
// Server — tools/call
// ---------------------------------------------------------------------------

describe("McpServer.toolsCallAsync", () => {
    function callRequest(name: string): JsonRpcRequest {
        return { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } };
    }

    it("reports an unknown tool as -32602", async () => {
        const server = new McpServer("s", {});
        server.register(new StubBehavior("t", [], [echoTool]));
        const res = await server.toolsCallAsync(callRequest("nope"));
        expect(res.error?.code).toBe(-32602);
        expect(res.error?.message).toContain("Unknown tool: nope");
    });

    it("reports a throwing tool as a tool execution error, not a protocol error", async () => {
        const server = new McpServer("s", {});
        server.register(
            new StubBehavior("t", [], [echoTool], () => {
                throw new Error("boom");
            })
        );

        const res = await server.toolsCallAsync(callRequest("echo"));
        expect(res.error).toBeUndefined();

        const result = res.result as { isError: boolean; content: { type: string; text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("boom");
    });
});

// ---------------------------------------------------------------------------
// Server — dispatch
// ---------------------------------------------------------------------------

describe("McpServer dispatch", () => {
    it("answers ping with an empty result", async () => {
        const { peer, received } = await rawServer();
        peer.send(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }));
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ jsonrpc: "2.0", id: 42, result: {} });
    });

    it("rejects a JSON-RPC batch with -32600 instead of dropping it", async () => {
        const { peer, received } = await rawServer();
        peer.send(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
        await flush();

        expect(received).toHaveLength(1);
        expect((received[0] as { error: { code: number } }).error.code).toBe(-32600);
    });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Minimal scripted MCP peer: answers `initialize` with a configurable
 * revision, serves `tools/list` from a list of pages, and records everything
 * the client sends.
 */
function scriptPeer(end: IMessageTransport, opts: { version?: string; pages?: { tools: McpTool[]; nextCursor?: string }[] } = {}): Record<string, unknown>[] {
    const seen: Record<string, unknown>[] = [];
    const pages = opts.pages ?? [];

    end.onMessage = (data) => {
        const msg = JSON.parse(data) as { id?: number; method?: string; params?: { cursor?: string } };
        seen.push(msg as Record<string, unknown>);
        if (msg.id === undefined || msg.method === undefined) return;

        if (msg.method === "initialize") {
            const result = {
                protocolVersion: opts.version ?? MCP_LATEST_PROTOCOL_VERSION,
                serverInfo: { name: "scripted", version: "1.0.0" },
                capabilities: {},
            };
            end.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
            return;
        }

        if (msg.method === "tools/list") {
            const index = msg.params?.cursor ? Number(msg.params.cursor) : 0;
            const page = pages[index] ?? { tools: [] };
            end.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: page }));
            return;
        }

        end.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    };

    return seen;
}

describe("McpClient handshake", () => {
    it("announces the latest revision and records the negotiated one", async () => {
        const [peerEnd, clientEnd] = LoopbackTransport.createPair();
        const seen = scriptPeer(peerEnd, { version: "2025-06-18" });

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        const result = await client.connect();

        expect((seen[0] as { params: { protocolVersion: string } }).params.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
        expect(result.protocolVersion).toBe("2025-06-18");
        expect(client.protocolVersion).toBe("2025-06-18");
    });

    it("refuses a revision it cannot speak", async () => {
        const [peerEnd, clientEnd] = LoopbackTransport.createPair();
        scriptPeer(peerEnd, { version: "1999-01-01" });

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await expect(client.connect()).rejects.toThrow(/unsupported MCP protocol version/);
        expect(client.isConnected).toBe(false);
    });
});

describe("McpClient pagination", () => {
    it("follows nextCursor until the last page", async () => {
        const [peerEnd, clientEnd] = LoopbackTransport.createPair();
        const seen = scriptPeer(peerEnd, {
            pages: [
                { tools: [{ name: "a", description: "a", inputSchema: {} }], nextCursor: "1" },
                { tools: [{ name: "b", description: "b", inputSchema: {} }], nextCursor: "2" },
                { tools: [{ name: "c", description: "c", inputSchema: {} }] },
            ],
        });

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await client.connect();
        const tools = await client.listTools();

        expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
        expect(seen.filter((m) => m.method === "tools/list")).toHaveLength(3);
    });

    it("stops when a server repeats a cursor", async () => {
        const [peerEnd, clientEnd] = LoopbackTransport.createPair();
        scriptPeer(peerEnd, { pages: [{ tools: [{ name: "a", description: "a", inputSchema: {} }], nextCursor: "0" }] });

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await client.connect();
        const tools = await client.listTools();

        expect(tools.map((t) => t.name)).toEqual(["a", "a"]);
    });
});

describe("McpClient inbound requests", () => {
    it("answers a server ping and refuses unknown methods", async () => {
        const [peerEnd, clientEnd] = LoopbackTransport.createPair();
        scriptPeer(peerEnd);

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await client.connect();

        const replies: Record<string, unknown>[] = [];
        peerEnd.onMessage = (data) => replies.push(JSON.parse(data) as Record<string, unknown>);

        peerEnd.send(JSON.stringify({ jsonrpc: "2.0", id: 900, method: "ping" }));
        peerEnd.send(JSON.stringify({ jsonrpc: "2.0", id: 901, method: "sampling/createMessage", params: {} }));
        await flush();

        expect(replies).toHaveLength(2);
        expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 900, result: {} });
        expect((replies[1] as { error: { code: number } }).error.code).toBe(-32601);
    });

    it("opens a transport through connect() without knowing its class", async () => {
        // The server and client must never branch on a concrete transport type:
        // that coupling is what would keep broker-specific transports from
        // living outside this package.
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        const wrapped = new CountingTransport(clientEnd);

        await new McpServerBuilder().withName("s").withTransport(serverEnd).build().start();

        const client = new McpClient({ name: "c", version: "1.0.0" }, wrapped);
        await client.connect();

        expect(wrapped.connectCalls).toBe(1);
        expect(client.isConnected).toBe(true);
    });

    it("resolves ping() against a live server", async () => {
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        await new McpServerBuilder().withName("s").withTransport(serverEnd).build().start();

        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await client.connect();
        await expect(client.ping()).resolves.toBeUndefined();
    });
});
