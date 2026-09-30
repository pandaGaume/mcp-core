import { describe, expect, it } from "vitest";
import { createEventEmitter, LoopbackTransport, McpAdapterBase, McpBehavior, McpClient, McpServer, McpServerBuilder } from "../src";
import type {
    IEventEmitter,
    IMcpBehavior,
    JsonRpcRequest,
    McpCompletion,
    McpCompletionArgument,
    McpCompletionReference,
    McpPrompt,
    McpPromptResult,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpTool,
    McpToolResult,
} from "../src/interfaces";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A behavior exposing one resource, one template, one prompt, and completion. */
class LiveBehavior implements IMcpBehavior {
    readonly namespace = "live";
    readonly updated: IEventEmitter<string> = createEventEmitter<string>();
    readonly listChanged: IEventEmitter<void> = createEventEmitter<void>();
    readonly promptsChanged: IEventEmitter<void> = createEventEmitter<void>();
    resources: McpResource[] = [{ uri: "live://gauge", name: "gauge" }];

    get onResourceUpdated() {
        return this.updated;
    }
    get onResourcesListChanged() {
        return this.listChanged;
    }
    get onPromptsChanged() {
        return this.promptsChanged;
    }

    getResources(): McpResource[] {
        return this.resources;
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [{ uriTemplate: "live://sensor/{id}", name: "sensor" }];
    }
    getTools(): McpTool[] {
        return [];
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return { uri, text: "42" };
    }
    async executeToolAsync(): Promise<McpToolResult> {
        return { content: [] };
    }
    getPrompts(): McpPrompt[] {
        return [{ name: "summarize", arguments: [{ name: "topic", required: true }] }];
    }
    async getPromptAsync(name: string, args: Record<string, string>): Promise<McpPromptResult | undefined> {
        if (name !== "summarize") return undefined;
        return { messages: [{ role: "user", content: { type: "text", text: `Summarize ${args["topic"]}` } }] };
    }
    async completeAsync(_ref: McpCompletionReference, argument: McpCompletionArgument): Promise<McpCompletion | undefined> {
        const all = Array.from({ length: 150 }, (_, i) => `${argument.value}${i}`);
        return { values: all };
    }
}

function req(method: string, params?: unknown, id = 1): JsonRpcRequest {
    return { jsonrpc: "2.0", id, method, params };
}

/** A server and a connected client over a loopback pair, with the handshake done. */
async function connected(behavior: IMcpBehavior, options = {}) {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName("s").withTransport(serverEnd).withOptions(options).register(behavior).build() as McpServer;
    await server.start();
    const client = new McpClient({ name: "c", version: "1.0.0" }, clientEnd);
    await client.connect();
    // Let `notifications/initialized` land before the test starts asserting.
    await new Promise((r) => setTimeout(r, 0));
    return { server, client };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// resources/subscribe
// ---------------------------------------------------------------------------

describe("resources/subscribe", () => {
    it("advertises subscribe alongside listChanged", async () => {
        const { client } = await connected(new LiveBehavior());
        expect(client.serverInfo).toBeDefined();
        const server = new McpServer("s", {});
        server.register(new LiveBehavior());
        const caps = (server.initialize(req("initialize", { clientInfo: { name: "c", version: "0" } })).result as { capabilities: Record<string, unknown> }).capabilities;
        expect(caps["resources"]).toEqual({ subscribe: true, listChanged: true });
    });

    it("delivers updated only for a subscribed URI", async () => {
        const behavior = new LiveBehavior();
        const { client } = await connected(behavior);
        const seen: string[] = [];
        client.onResourceUpdated.subscribe((uri) => seen.push(uri));

        behavior.updated.emit("live://gauge");
        await flush();
        expect(seen).toEqual([]);

        await client.subscribeResource("live://gauge");
        behavior.updated.emit("live://gauge");
        behavior.updated.emit("live://sensor/7");
        await flush();
        expect(seen).toEqual(["live://gauge"]);
    });

    it("accepts a URI matching a template and matches it exactly", async () => {
        const behavior = new LiveBehavior();
        const { client } = await connected(behavior);
        const seen: string[] = [];
        client.onResourceUpdated.subscribe((uri) => seen.push(uri));

        await client.subscribeResource("live://sensor/7");
        behavior.updated.emit("live://sensor/7");
        behavior.updated.emit("live://sensor/8");
        await flush();
        expect(seen).toEqual(["live://sensor/7"]);
    });

    it("stops delivering after unsubscribe, and unsubscribe is idempotent", async () => {
        const behavior = new LiveBehavior();
        const { client } = await connected(behavior);
        const seen: string[] = [];
        client.onResourceUpdated.subscribe((uri) => seen.push(uri));

        await client.subscribeResource("live://gauge");
        await client.subscribeResource("live://gauge");
        await client.unsubscribeResource("live://gauge");
        await client.unsubscribeResource("live://gauge");
        await client.unsubscribeResource("live://never");
        behavior.updated.emit("live://gauge");
        await flush();
        expect(seen).toEqual([]);
    });

    it("refuses a URI nothing can read with -32002", () => {
        const server = new McpServer("s", {});
        server.register(new LiveBehavior());
        expect(server.resourcesSubscribe(req("resources/subscribe", { uri: "live://nowhere" })).error?.code).toBe(-32002);
        expect(server.resourcesSubscribe(req("resources/subscribe", {})).error?.code).toBe(-32602);
    });

    it("forgets subscriptions when the session disconnects", async () => {
        const behavior = new LiveBehavior();
        const { server, client } = await connected(behavior);
        await client.subscribeResource("live://gauge");
        expect(server.isSubscribed("live://gauge")).toBe(true);
        client.disconnect();
        await flush();
        expect(server.isSubscribed("live://gauge")).toBe(false);
    });

    it("re-indexes and announces list_changed when a behavior's resources change", async () => {
        const behavior = new LiveBehavior();
        const { server, client } = await connected(behavior);
        let changes = 0;
        client.onResourcesChanged?.subscribe(() => changes++);

        behavior.resources = [{ uri: "live://other", name: "other" }];
        behavior.listChanged.emit();
        await flush();
        expect(changes).toBe(1);
        expect(server.resourcesSubscribe(req("resources/subscribe", { uri: "live://other" })).error).toBeUndefined();
        expect(server.resourcesSubscribe(req("resources/subscribe", { uri: "live://gauge" })).error?.code).toBe(-32002);
    });

    it("stops listening to a behavior once it is unregistered", async () => {
        const behavior = new LiveBehavior();
        const { server, client } = await connected(behavior);
        const seen: string[] = [];
        client.onResourceUpdated.subscribe((uri) => seen.push(uri));
        await client.subscribeResource("live://gauge");

        server.unregister(behavior);
        behavior.updated.emit("live://gauge");
        await flush();
        expect(seen).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// McpBehavior forwards its adapter's change events
// ---------------------------------------------------------------------------

class CountingAdapter extends McpAdapterBase {
    reads = 0;
    constructor() {
        super("test");
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        this.reads++;
        return { uri, text: String(this.reads) };
    }
    async executeToolAsync(): Promise<McpToolResult> {
        return { content: [] };
    }
    changed(uri: string): void {
        this._forwardResourceContentChanged(uri);
    }
}

class RootBehavior extends McpBehavior {
    constructor(adapter: CountingAdapter) {
        super(adapter, { domain: "test", namespace: "root" });
    }
    protected override _buildResources(): McpResource[] {
        return [{ uri: "test://root", name: "root" }];
    }
}

describe("McpBehavior", () => {
    it("forwards adapter content changes as onResourceUpdated and drops the stale cache", async () => {
        const adapter = new CountingAdapter();
        const behavior = new RootBehavior(adapter);
        const seen: string[] = [];
        behavior.onResourceUpdated.subscribe((uri) => seen.push(uri));

        expect((await behavior.readResourceAsync("test://root"))?.text).toBe("1");
        expect((await behavior.readResourceAsync("test://root"))?.text).toBe("1");
        adapter.changed("test://root");
        expect(seen).toEqual(["test://root"]);
        expect((await behavior.readResourceAsync("test://root"))?.text).toBe("2");
    });
});

// ---------------------------------------------------------------------------
// prompts, completion, logging
// ---------------------------------------------------------------------------

describe("prompts", () => {
    it("lists and expands prompts end to end", async () => {
        const { client } = await connected(new LiveBehavior());
        expect((await client.listPrompts()).map((p) => p.name)).toEqual(["summarize"]);
        const result = await client.getPrompt("summarize", { topic: "tides" });
        expect(result.messages[0].content).toEqual({ type: "text", text: "Summarize tides" });
    });

    it("refuses an unknown prompt, a missing required argument and a non-string argument with -32602", async () => {
        const server = new McpServer("s", {});
        server.register(new LiveBehavior());
        expect((await server.promptsGetAsync(req("prompts/get", { name: "nope" }))).error?.code).toBe(-32602);
        const missing = await server.promptsGetAsync(req("prompts/get", { name: "summarize" }));
        expect(missing.error?.code).toBe(-32602);
        expect(missing.error?.message).toContain("topic");
        expect((await server.promptsGetAsync(req("prompts/get", { name: "summarize", arguments: { topic: 3 } }))).error?.code).toBe(-32602);
    });

    it("advertises prompts only when a behavior has some", () => {
        const server = new McpServer("s", {});
        server.register(new LiveBehavior());
        const caps = (server.initialize(req("initialize", {})).result as { capabilities: Record<string, unknown> }).capabilities;
        expect(caps["prompts"]).toEqual({ listChanged: true });
        expect(caps["completions"]).toEqual({});
        expect(caps["logging"]).toBeUndefined();
    });

    it("forwards onPromptsChanged as prompts/list_changed", async () => {
        const behavior = new LiveBehavior();
        const { client } = await connected(behavior);
        let changes = 0;
        client.onPromptsChanged.subscribe(() => changes++);
        behavior.promptsChanged.emit();
        await flush();
        expect(changes).toBe(1);
    });
});

describe("completion/complete", () => {
    it("routes to the owning behavior and caps values at 100", async () => {
        const { client } = await connected(new LiveBehavior());
        const completion = await client.complete({ type: "ref/prompt", name: "summarize" }, { name: "topic", value: "t" });
        expect(completion.values).toHaveLength(100);
        expect(completion.total).toBe(150);
        expect(completion.hasMore).toBe(true);
    });

    it("refuses a reference no behavior owns with -32602", async () => {
        const server = new McpServer("s", {});
        server.register(new LiveBehavior());
        const res = await server.completionCompleteAsync(req("completion/complete", { ref: { type: "ref/resource", uri: "x://{y}" }, argument: { name: "y", value: "" } }));
        expect(res.error?.code).toBe(-32602);
    });
});

describe("logging", () => {
    it("is -32601 and silent unless enabled", async () => {
        const { server, client } = await connected(new LiveBehavior());
        await expect(client.setLoggingLevel("debug")).rejects.toThrow("-32601");
        expect(server.log("error", "x")).toBe(false);
    });

    it("filters by the level the client set", async () => {
        const { server, client } = await connected(new LiveBehavior(), { logging: true });
        expect(server.log("debug", "hidden")).toBe(false);
        expect(server.log("info", "shown")).toBe(true);
        await client.setLoggingLevel("error");
        expect(server.log("warning", "hidden")).toBe(false);
        expect(server.log("critical", "shown")).toBe(true);
    });
});
