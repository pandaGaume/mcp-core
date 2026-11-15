import { describe, expect, it } from "vitest";
import { LoopbackTransport, McpAdapterBase, McpBehavior, McpClient, McpServer, McpServerBuilder, McpToolResults } from "../src";
import type { IMcpBehavior, McpTool, McpToolResult } from "../src/interfaces";
import { WEBMCP_META_KEY, WebMcpAdapter, WebMcpBehavior, WebMcpExporter, getModelContext } from "../src/web";
import type { WebMcpAdapterOptions, WebMcpModelContext, WebMcpRegisteredTool, WebMcpRegisterToolOptions, WebMcpToolDefinition } from "../src/web";

// ---------------------------------------------------------------------------
// A fake `document.modelContext`, following the 2026-11-13 draft: duplicate
// names are refused, aborting the signal unregisters, `toolchange` is queued,
// and a failing callback reaches the caller as a bare OperationError.
// ---------------------------------------------------------------------------

interface IEntry {
    def: WebMcpToolDefinition;
    origin: string;
}

class FakeModelContext extends EventTarget implements WebMcpModelContext {
    readonly registry = new Map<string, IEntry>();
    readonly options = new Map<string, WebMcpRegisterToolOptions | undefined>();

    constructor(readonly origin = "https://app.test") {
        super();
    }

    async registerTool(def: WebMcpToolDefinition, options?: WebMcpRegisterToolOptions): Promise<void> {
        if (!def.name || !def.description) throw new TypeError("name and description are required");
        if (this.registry.has(def.name)) throw new DOMException(`"${def.name}" is already registered`, "InvalidStateError");
        if (options?.signal?.aborted) return;
        const entry = { def, origin: this.origin };
        this.registry.set(def.name, entry);
        this.options.set(def.name, options);
        options?.signal?.addEventListener(
            "abort",
            () => {
                if (this.registry.get(def.name) !== entry) return;
                this.registry.delete(def.name);
                this._changed();
            },
            { once: true }
        );
        this._changed();
    }

    /** Registers a tool on behalf of another document. */
    async registerFrom(origin: string, def: WebMcpToolDefinition): Promise<void> {
        this.registry.set(`${origin}#${def.name}`, { def, origin });
        this._changed();
    }

    async getTools(): Promise<WebMcpRegisteredTool[]> {
        return [...this.registry.values()].map(({ def, origin }) => ({
            name: def.name,
            description: def.description,
            origin,
            ...(def.title ? { title: def.title } : {}),
            ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
            ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
            ...(def.annotations ? { annotations: def.annotations } : {}),
        }));
    }

    async executeTool(tool: WebMcpRegisteredTool, input: object = {}): Promise<string> {
        const entry = [...this.registry.values()].find((e) => e.def.name === tool.name && e.origin === tool.origin);
        if (!entry) throw new DOMException(`"${tool.name}" is not registered`, "NotFoundError");
        let value: unknown;
        try {
            value = await entry.def.execute(input as Record<string, unknown>, { signal: new AbortController().signal });
        } catch {
            throw new DOMException("The tool failed", "OperationError");
        }
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new DOMException("unserializable result", "OperationError");
        return serialized;
    }

    /** Calls a registered tool the way a browser agent would. */
    async call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
        const entry = this.registry.get(name);
        if (!entry) throw new Error(`no tool ${name}`);
        return entry.def.execute(input, { signal: new AbortController().signal });
    }

    private _changed(): void {
        queueMicrotask(() => this.dispatchEvent(new Event("toolchange")));
    }
}

// ---------------------------------------------------------------------------
// MCP fixtures
// ---------------------------------------------------------------------------

class PlantAdapter extends McpAdapterBase {
    value = 0;
    extra = false;
    constructor() {
        super("plant");
    }
    async readResourceAsync() {
        return undefined;
    }
    async executeToolAsync(_uri: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (tool === "gauge_set") {
            this.value = Number(args.value);
            return McpToolResults.json({ value: this.value });
        }
        if (tool === "gauge_reset") return McpToolResults.error("reset is locked");
        return McpToolResults.text(`ran ${tool}`);
    }
    toggleExtra(): void {
        this.extra = !this.extra;
        this._forwardToolsChanged();
    }
}

class PlantBehavior extends McpBehavior {
    constructor(private readonly _plant: PlantAdapter) {
        super(_plant, { namespace: "plant" });
    }
    protected override _buildTools(): McpTool[] {
        const tools: McpTool[] = [
            {
                name: "gauge_set",
                title: "Set gauge",
                description: "Set the gauge.",
                inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
                outputSchema: { type: "object", properties: { value: { type: "number" } } },
                annotations: { destructiveHint: true, openWorldHint: false },
            },
            { name: "gauge_reset", description: "Reset the gauge.", inputSchema: { type: "object" } },
            { name: "gauge_read", description: "Read the gauge.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
        ];
        if (this._plant.extra) tools.push({ name: "gauge_extra", description: "Only sometimes.", inputSchema: { type: "object" } });
        return tools;
    }
}

class OtherBehavior extends McpBehavior {
    constructor(name = "other_ping") {
        super(new PlantAdapter(), { namespace: "other" });
        this._toolName = name;
    }
    private _toolName: string;
    protected override _buildTools(): McpTool[] {
        return [{ name: this._toolName, description: "Ping.", inputSchema: { type: "object" } }];
    }
}

async function connected(...behaviors: IMcpBehavior[]) {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder()
        .withName("s")
        .withTransport(serverEnd)
        .register(...behaviors)
        .build() as McpServer;
    await server.start();
    const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
    await client.connect();
    await settle();
    return { server, client };
}

/** Lets queued microtasks, loopback deliveries and refreshes run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Core: tool list changes
// ---------------------------------------------------------------------------

describe("tools/list_changed from behaviors", () => {
    it("forwards an adapter's tool change and serves the new list", async () => {
        const adapter = new PlantAdapter();
        const { client } = await connected(new PlantBehavior(adapter));
        let changes = 0;
        client.onToolsChanged!.subscribe(() => changes++);

        expect((await client.listTools()).map((t) => t.name)).not.toContain("gauge_extra");
        adapter.toggleExtra();
        await settle();

        expect(changes).toBe(1);
        expect((await client.listTools()).map((t) => t.name)).toContain("gauge_extra");
    });

    it("announces a behavior registered or unregistered at runtime", async () => {
        const { server, client } = await connected(new PlantBehavior(new PlantAdapter()));
        let changes = 0;
        client.onToolsChanged!.subscribe(() => changes++);

        const other = new OtherBehavior();
        server.register(other);
        await settle();
        expect(changes).toBe(1);

        server.unregister(other);
        await settle();
        expect(changes).toBe(2);
    });

    it("advertises tools for a dynamicTools behavior that has none yet", async () => {
        const server = new McpServer("s", {});
        server.register(new WebMcpBehavior(new WebMcpAdapter({ modelContext: new FakeModelContext() })));
        const caps = (server.initialize({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }).result as { capabilities: Record<string, unknown> }).capabilities;
        expect(caps["tools"]).toEqual({ listChanged: true });
    });
});

// ---------------------------------------------------------------------------
// MCP server -> WebMCP
// ---------------------------------------------------------------------------

describe("WebMcpExporter", () => {
    async function exported(...behaviors: IMcpBehavior[]) {
        const context = new FakeModelContext();
        const { server, client } = await connected(...behaviors);
        const errors: string[] = [];
        const exporter = new WebMcpExporter(client, { modelContext: context, onError: (e) => errors.push(e.message) });
        await exporter.start();
        return { context, server, client, exporter, errors };
    }

    it("publishes every tool with its title, schemas and mapped hints", async () => {
        const { context, exporter } = await exported(new PlantBehavior(new PlantAdapter()));
        expect(exporter.publishedTools.sort()).toEqual(["gauge_read", "gauge_reset", "gauge_set"]);

        const set = context.registry.get("gauge_set")!.def;
        expect(set.title).toBe("Set gauge");
        expect(set.outputSchema).toEqual({ type: "object", properties: { value: { type: "number" } } });
        expect(set.annotations).toEqual({ consequentialHint: true });
        // Read-only wins over a contradictory destructive hint.
        expect(context.registry.get("gauge_read")!.def.annotations).toEqual({ readOnlyHint: true });
        expect(context.registry.get("gauge_reset")!.def.annotations).toBeUndefined();
    });

    it("passes exposedTo through to registerTool", async () => {
        const context = new FakeModelContext();
        const { client } = await connected(new PlantBehavior(new PlantAdapter()));
        await new WebMcpExporter(client, { modelContext: context, exposedTo: ["https://agent.test"] }).start();
        expect(context.options.get("gauge_set")?.exposedTo).toEqual(["https://agent.test"]);
    });

    it("returns structured content, and errors as readable results", async () => {
        const adapter = new PlantAdapter();
        const { context } = await exported(new PlantBehavior(adapter));

        expect(await context.call("gauge_set", { value: 7 })).toEqual({ value: 7 });
        expect(adapter.value).toBe(7);
        expect(await context.call("gauge_reset")).toEqual({ content: [{ type: "text", text: "reset is locked" }], isError: true });
        expect(await context.call("gauge_read")).toEqual({ content: [{ type: "text", text: "ran gauge_read" }] });
    });

    it("turns a protocol error into a tool error the agent can read", async () => {
        const plant = new PlantBehavior(new PlantAdapter());
        const { context, server } = await exported(plant);
        // The tool vanishes on the server; the call races the list refresh.
        server.unregister(plant);
        const result = (await context.call("gauge_set", { value: 1 })) as McpToolResult;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("-32602");
    });

    it("follows the server's list: adds, removes, and re-registers changed tools", async () => {
        const adapter = new PlantAdapter();
        const { context, server, exporter } = await exported(new PlantBehavior(adapter));

        const other = new OtherBehavior();
        server.register(other);
        await settle();
        expect(exporter.publishedTools).toContain("other_ping");

        adapter.toggleExtra();
        await settle();
        expect(context.registry.has("gauge_extra")).toBe(true);

        server.unregister(other);
        await settle();
        expect(context.registry.has("other_ping")).toBe(false);
        expect(exporter.publishedTools).not.toContain("other_ping");
    });

    it("reports names WebMCP refuses instead of publishing them", async () => {
        const { exporter, errors } = await exported(new OtherBehavior("bad name!"));
        expect(exporter.publishedTools).toEqual([]);
        expect(errors[0]).toContain('"bad name!" is not a valid WebMCP tool name');
    });

    it("reports a name another script already registered", async () => {
        const context = new FakeModelContext();
        await context.registerTool({ name: "other_ping", description: "taken", execute: async () => ({}) });
        const { client } = await connected(new OtherBehavior());
        const errors: string[] = [];
        await new WebMcpExporter(client, { modelContext: context, onError: (e) => errors.push(e.message) }).start();
        expect(errors[0]).toContain("already registered");
        expect(context.registry.get("other_ping")!.def.description).toBe("taken");
    });

    it("applies the filter", async () => {
        const context = new FakeModelContext();
        const { client } = await connected(new PlantBehavior(new PlantAdapter()));
        await new WebMcpExporter(client, { modelContext: context, filter: (t) => t.annotations?.readOnlyHint === true }).start();
        expect([...context.registry.keys()]).toEqual(["gauge_read"]);
    });

    it("unregisters everything on stop", async () => {
        const { context, exporter } = await exported(new PlantBehavior(new PlantAdapter()));
        exporter.stop();
        expect(context.registry.size).toBe(0);
        expect(exporter.publishedTools).toEqual([]);
    });

    it("refuses to start without WebMCP", async () => {
        const { client } = await connected(new PlantBehavior(new PlantAdapter()));
        await expect(new WebMcpExporter(client).start()).rejects.toThrow("document.modelContext is missing");
    });
});

// ---------------------------------------------------------------------------
// WebMCP -> MCP server
// ---------------------------------------------------------------------------

describe("WebMcpAdapter and WebMcpBehavior", () => {
    async function served(context: FakeModelContext, options: Omit<WebMcpAdapterOptions, "modelContext"> = {}) {
        const errors: string[] = [];
        const adapter = new WebMcpAdapter({ modelContext: context, onError: (e) => errors.push(e.message), ...options });
        await adapter.start();
        const { server, client } = await connected(new WebMcpBehavior(adapter));
        return { adapter, server, client, errors };
    }

    it("lists the page's tools with their schemas, hints and origin", async () => {
        const context = new FakeModelContext();
        await context.registerTool({
            name: "cart_add",
            title: "Add to cart",
            description: "Adds an item.",
            inputSchema: { type: "object", properties: { sku: { type: "string" } } },
            annotations: { consequentialHint: true, untrustedContentHint: true },
            execute: async () => ({}),
        });
        const { client } = await served(context);

        const [tool] = await client.listTools();
        expect(tool.name).toBe("cart_add");
        expect(tool.title).toBe("Add to cart");
        expect(tool.inputSchema).toEqual({ type: "object", properties: { sku: { type: "string" } } });
        expect(tool.annotations).toEqual({ title: "Add to cart", destructiveHint: true, openWorldHint: true });
        expect(tool._meta?.[WEBMCP_META_KEY]).toEqual({ origin: "https://app.test", annotations: { consequentialHint: true, untrustedContentHint: true } });
    });

    it("runs a call through executeTool and shapes the result", async () => {
        const context = new FakeModelContext();
        await context.registerTool({ name: "sum", description: "Adds.", execute: async (i) => ({ total: Number(i.a) + Number(i.b) }) });
        await context.registerTool({ name: "hello", description: "Greets.", execute: async () => "hi" });
        await context.registerTool({ name: "list", description: "Lists.", execute: async () => [1, 2] });
        const { client } = await served(context);

        expect(await client.callTool("sum", { a: 2, b: 3 })).toEqual({ content: [{ type: "text", text: '{"total":5}' }], structuredContent: { total: 5 }, isError: false });
        expect(await client.callTool("hello", {})).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
        expect(await client.callTool("list", {})).toEqual({ content: [{ type: "text", text: "[1,2]" }], isError: false });
    });

    it("reports a failing page tool as isError", async () => {
        const context = new FakeModelContext();
        await context.registerTool({
            name: "boom",
            description: "Fails.",
            execute: async () => {
                throw new Error("secret reason");
            },
        });
        const { client } = await served(context);
        const result = await client.callTool("boom", {});
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("OperationError");
    });

    it("tells the client when the page registers or drops a tool", async () => {
        const context = new FakeModelContext();
        const { client } = await served(context);
        let changes = 0;
        client.onToolsChanged!.subscribe(() => changes++);
        expect(await client.listTools()).toEqual([]);

        const controller = new AbortController();
        await context.registerTool({ name: "late", description: "Late.", execute: async () => ({}) }, { signal: controller.signal });
        await settle();
        expect(changes).toBe(1);
        expect((await client.listTools()).map((t) => t.name)).toEqual(["late"]);

        controller.abort();
        await settle();
        expect(changes).toBe(2);
        expect(await client.listTools()).toEqual([]);
        await expect(client.callTool("late", {})).rejects.toThrow("-32602");
    });

    it("keeps the first of two documents using one name, and applies the filter", async () => {
        const context = new FakeModelContext();
        await context.registerTool({ name: "search", description: "Page search.", execute: async () => ({ from: "page" }) });
        await context.registerFrom("https://widget.test", { name: "search", description: "Widget search.", execute: async () => ({ from: "widget" }) });
        await context.registerTool({ name: "debug_dump", description: "Dumps.", execute: async () => ({}) });
        const { client, errors } = await served(context, { filter: (t) => !t.name.startsWith("debug_") });

        expect((await client.listTools()).map((t) => t.name)).toEqual(["search"]);
        expect((await client.callTool("search", {})).structuredContent).toEqual({ from: "page" });
        expect(errors[0]).toContain("keeping https://app.test");
    });

    it("round-trips a tool published by a WebMcpExporter", async () => {
        const context = new FakeModelContext();
        const plant = new PlantAdapter();
        const { client: source } = await connected(new PlantBehavior(plant));
        await new WebMcpExporter(source, { modelContext: context }).start();

        const { client } = await served(context);
        expect(await client.callTool("gauge_set", { value: 4 })).toEqual({ content: [{ type: "text", text: '{"value":4}' }], structuredContent: { value: 4 }, isError: false });
        expect(await client.callTool("gauge_reset", {})).toEqual({ content: [{ type: "text", text: "reset is locked" }], isError: true });
        expect(plant.value).toBe(4);
    });

    it("finds document.modelContext only when it looks like WebMCP", () => {
        expect(getModelContext({ modelContext: new FakeModelContext() })).toBeDefined();
        expect(getModelContext({ modelContext: {} })).toBeUndefined();
        expect(getModelContext(undefined)).toBeUndefined();
    });
});
