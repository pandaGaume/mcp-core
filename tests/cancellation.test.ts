import { describe, expect, it } from "vitest";
import { LoopbackTransport, McpAdapterBase, McpBehavior, McpClient, McpServer, McpServerBuilder, McpToolResults } from "../src";
import type { IMcpRequestContext, IMessageTransport, McpTool, McpToolResult } from "../src/interfaces";
import { WebMcpAdapter, WebMcpBehavior, WebMcpExporter } from "../src/web";
import type { WebMcpModelContext, WebMcpRegisteredTool, WebMcpToolDefinition } from "../src/web";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tool that waits until it is released or its request is cancelled. */
class SlowAdapter extends McpAdapterBase {
    signals: AbortSignal[] = [];
    private _release: Array<() => void> = [];

    constructor() {
        super("slow");
    }
    async readResourceAsync() {
        return undefined;
    }
    async executeToolAsync(_uri: string, _tool: string, _args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        if (request?.signal) this.signals.push(request.signal);
        await new Promise<void>((resolve) => {
            this._release.push(resolve);
            request?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return McpToolResults.text(request?.signal?.aborted ? "stopped" : "done");
    }
    releaseAll(): void {
        for (const r of this._release.splice(0)) r();
    }
}

class SlowBehavior extends McpBehavior {
    constructor(adapter: SlowAdapter) {
        super(adapter, { namespace: "slow" });
    }
    protected override _buildTools(): McpTool[] {
        return [{ name: "slow_wait", description: "Waits.", inputSchema: { type: "object" } }];
    }
}

/** Records every frame the client end sends, and every frame it receives. */
function tap(transport: IMessageTransport): { sent: unknown[] } {
    const log = { sent: [] as unknown[] };
    const send = transport.send.bind(transport);
    transport.send = (data: string) => {
        log.sent.push(JSON.parse(data));
        send(data);
    };
    return log;
}

async function connected(timeoutMs?: number) {
    const adapter = new SlowAdapter();
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const serverLog = tap(serverEnd);
    const clientLog = tap(clientEnd);
    const server = new McpServerBuilder().withName("s").withTransport(serverEnd).register(new SlowBehavior(adapter)).build() as McpServer;
    await server.start();
    const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd, timeoutMs);
    await client.connect();
    await settle();
    return { adapter, server, client, serverEnd, clientEnd, serverLog, clientLog };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const isCancelled = (m: unknown): m is { method: string; params: { requestId: number; reason?: string } } => (m as { method?: string }).method === "notifications/cancelled";
const toolCallIds = (frames: unknown[]) => frames.filter((m) => (m as { method?: string }).method === "tools/call").map((m) => (m as { id: number }).id);

// ---------------------------------------------------------------------------
// Client and server
// ---------------------------------------------------------------------------

describe("cancellation", () => {
    it("withdraws an aborted call, aborts the server's signal, and gets no answer", async () => {
        const { adapter, client, clientLog, serverLog } = await connected();
        const controller = new AbortController();
        const call = client.callTool("slow_wait", {}, { signal: controller.signal });
        await settle();

        controller.abort("user changed their mind");
        await expect(call).rejects.toMatchObject({ name: "AbortError" });
        await settle();

        const [id] = toolCallIds(clientLog.sent);
        expect(clientLog.sent.filter(isCancelled)).toEqual([{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "user changed their mind" } }]);
        expect(adapter.signals[0].aborted).toBe(true);
        expect((adapter.signals[0].reason as Error).message).toBe("user changed their mind");
        // The server sent nothing back for the cancelled id.
        expect(serverLog.sent.some((m) => (m as { id?: unknown }).id === id)).toBe(false);
    });

    it("rejects an already aborted signal without sending anything", async () => {
        const { client, clientLog } = await connected();
        const before = clientLog.sent.length;
        await expect(client.callTool("slow_wait", {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
        expect(clientLog.sent.length).toBe(before);
    });

    it("withdraws a request that timed out", async () => {
        const { adapter, client, clientLog } = await connected(50);
        await expect(client.callTool("slow_wait", {})).rejects.toThrow("timed out");
        await settle();
        const cancelled = clientLog.sent.filter(isCancelled);
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0].params.reason).toContain("timed out");
        expect(adapter.signals[0].aborted).toBe(true);
    });

    it("answers normally when the call completes before any abort", async () => {
        const { adapter, client, clientLog } = await connected();
        const controller = new AbortController();
        const call = client.callTool("slow_wait", {}, { signal: controller.signal });
        await settle();
        adapter.releaseAll();
        expect((await call).content).toEqual([{ type: "text", text: "done" }]);
        controller.abort();
        await settle();
        expect(clientLog.sent.filter(isCancelled)).toEqual([]);
    });

    it("ignores a cancellation for an unknown id, and one aimed at another request", async () => {
        const { adapter, client, clientEnd } = await connected();
        const call = client.callTool("slow_wait", {});
        await settle();
        clientEnd.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } }));
        clientEnd.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "2" } }));
        await settle();
        expect(adapter.signals[0].aborted).toBe(false);
        adapter.releaseAll();
        expect((await call).content).toEqual([{ type: "text", text: "done" }]);
    });

    it("aborts the work of a session that disconnected", async () => {
        const { adapter, client, serverEnd } = await connected();
        void client.callTool("slow_wait", {}).catch(() => undefined);
        await settle();
        serverEnd.close();
        await settle();
        expect(adapter.signals[0].aborted).toBe(true);
    });

    it("leaves a context without a signal for requests served outside a session", async () => {
        const server = new McpServer("s", {});
        const adapter = new SlowAdapter();
        server.register(new SlowBehavior(adapter));
        const pending = server.toolsCallAsync({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_wait", arguments: {} } });
        await settle();
        expect(adapter.signals).toEqual([]);
        adapter.releaseAll();
        await pending;
    });
});

// ---------------------------------------------------------------------------
// WebMCP, both ways
// ---------------------------------------------------------------------------

/** The smallest registry that runs a tool with the caller's signal. */
class TinyModelContext extends EventTarget implements WebMcpModelContext {
    readonly tools = new Map<string, WebMcpToolDefinition>();
    async registerTool(def: WebMcpToolDefinition): Promise<void> {
        this.tools.set(def.name, def);
    }
    async getTools(): Promise<WebMcpRegisteredTool[]> {
        return [...this.tools.values()].map((d) => ({ name: d.name, description: d.description, origin: "https://app.test" }));
    }
    async executeTool(tool: WebMcpRegisteredTool, input: object = {}, options?: { signal?: AbortSignal }): Promise<string> {
        const def = this.tools.get(tool.name)!;
        return JSON.stringify(await def.execute(input as Record<string, unknown>, { signal: options?.signal ?? new AbortController().signal }));
    }
}

describe("cancellation through WebMCP", () => {
    it("withdraws the server call when the browser agent cancels an exported tool", async () => {
        const { adapter, client, clientLog } = await connected();
        const context = new TinyModelContext();
        await new WebMcpExporter(client, { modelContext: context }).start();

        const controller = new AbortController();
        const run = context.tools.get("slow_wait")!.execute({}, { signal: controller.signal });
        await settle();
        controller.abort();
        await expect(run).rejects.toMatchObject({ name: "AbortError" });
        await settle();

        expect(clientLog.sent.filter(isCancelled)).toHaveLength(1);
        expect(adapter.signals[0].aborted).toBe(true);
    });

    it("aborts the page tool when the MCP client cancels a re-served call", async () => {
        const context = new TinyModelContext();
        const seen: AbortSignal[] = [];
        await context.registerTool({
            name: "page_wait",
            description: "Waits on the page.",
            execute: (_input, { signal }) => {
                seen.push(signal);
                return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopped: true }), { once: true }));
            },
        });
        const webmcp = new WebMcpAdapter({ modelContext: context });
        await webmcp.start();
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        await new McpServerBuilder().withName("page").withTransport(serverEnd).register(new WebMcpBehavior(webmcp)).build().start();
        const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
        await client.connect();

        const controller = new AbortController();
        const call = client.callTool("page_wait", {}, { signal: controller.signal });
        await settle();
        controller.abort();
        await expect(call).rejects.toMatchObject({ name: "AbortError" });
        await settle();
        expect(seen[0].aborted).toBe(true);
    });
});
