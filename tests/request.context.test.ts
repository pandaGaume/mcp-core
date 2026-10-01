import { describe, expect, it } from "vitest";
import { LoopbackTransport, McpAdapterBase, McpBehavior, McpServer, McpServerBuilder, McpToolResults } from "../src";
import type {
    IMcpRequestContext,
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

/**
 * Every runtime operation receives the request it serves, as an optional last
 * argument: id, method, and `params._meta` verbatim. A relay in front of the
 * server (a broker) puts there what the adapter needs to know about the
 * caller, so the context has to reach the adapter through every layer, and an
 * adapter written before it existed has to keep working unchanged.
 */

/** Records the request context each operation received. */
class RecordingAdapter extends McpAdapterBase {
    readonly seen: { op: string; request?: IMcpRequestContext }[] = [];

    constructor() {
        super("rec");
    }

    async readResourceAsync(uri: string, request?: IMcpRequestContext): Promise<McpResourceContent | undefined> {
        this.seen.push({ op: "read", request });
        return { uri, text: "x" };
    }

    async executeToolAsync(_uri: string, _tool: string, _args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        this.seen.push({ op: "call", request });
        return McpToolResults.json({ ok: true });
    }
}

class RecordingBehavior extends McpBehavior {
    constructor(readonly recorder: RecordingAdapter) {
        super(recorder, { namespace: "rec" });
    }

    protected override _buildResources(): McpResource[] {
        return [{ uri: "rec://root", name: "root" }];
    }

    protected override _buildTemplate(): McpResourceTemplate[] {
        return [{ uriTemplate: "rec://item/{id}", name: "item" }];
    }

    protected override _buildTools(): McpTool[] {
        return [{ name: "rec_do", description: "do", inputSchema: { type: "object" } }];
    }

    getPrompts(): McpPrompt[] {
        return [{ name: "p" }];
    }

    async getPromptAsync(_name: string, _args: Record<string, string>, request?: IMcpRequestContext): Promise<McpPromptResult | undefined> {
        this.recorder.seen.push({ op: "prompt", request });
        return { messages: [] };
    }

    async completeAsync(
        _ref: McpCompletionReference,
        _argument: McpCompletionArgument,
        _context?: { arguments?: Record<string, string> },
        request?: IMcpRequestContext
    ): Promise<McpCompletion | undefined> {
        this.recorder.seen.push({ op: "complete", request });
        return { values: [] };
    }
}

/** An adapter written against 1.3.0: no request parameter anywhere. */
class LegacyAdapter extends McpAdapterBase {
    constructor() {
        super("legacy");
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return { uri, text: "legacy" };
    }
    async executeToolAsync(_uri: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return McpToolResults.json({ tool, args });
    }
}

class LegacyBehavior extends McpBehavior {
    constructor() {
        super(new LegacyAdapter(), { namespace: "legacy" });
    }
    protected override _buildTemplate(): McpResourceTemplate[] {
        return [{ uriTemplate: "legacy://item/{id}", name: "item" }];
    }
    protected override _buildTools(): McpTool[] {
        return [{ name: "legacy_do", description: "do", inputSchema: { type: "object" } }];
    }
}

function req(method: string, params?: unknown, id: string | number = 1): JsonRpcRequest {
    return { jsonrpc: "2.0", id, method, params };
}

async function serve(...behaviors: McpBehavior[]): Promise<McpServer> {
    const [serverEnd] = LoopbackTransport.createPair();
    const builder = new McpServerBuilder().withName("s").withTransport(serverEnd);
    for (const b of behaviors) builder.register(b);
    const server = builder.build() as McpServer;
    await server.start();
    return server;
}

const META = { "io.cyanmycelium/caller": { ref: "cr_1", correlationId: "req-1" }, progressToken: 7 };

describe("the request context", () => {
    it("reaches the adapter on tools/call, with id, method and _meta", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.toolsCallAsync(req("tools/call", { name: "rec_do", arguments: {}, _meta: META }, "call-1"));

        expect(recorder.seen).toEqual([{ op: "call", request: { requestId: "call-1", method: "tools/call", meta: META } }]);
    });

    it("reaches the adapter on the singleton fallback of tools/call too", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.toolsCallAsync(req("tools/call", { name: "rec_do", _meta: META }));

        expect(recorder.seen[0]?.request?.meta).toEqual(META);
    });

    it("reaches the adapter on resources/read of an instance URI", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.resourcesRead(req("resources/read", { uri: "rec://item/3", _meta: META }, 9));

        expect(recorder.seen).toEqual([{ op: "read", request: { requestId: 9, method: "resources/read", meta: META } }]);
    });

    it("is not given to the shared, cached root resource", async () => {
        // The root content is built once and served to every caller; building it
        // with one caller's context would serve that caller's view to everyone.
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.resourcesRead(req("resources/read", { uri: "rec://root", _meta: META }));

        expect(recorder.seen).toEqual([{ op: "read", request: undefined }]);
    });

    it("reaches prompts/get and completion/complete", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.promptsGetAsync(req("prompts/get", { name: "p", _meta: META }, 2));
        await server.completionCompleteAsync(req("completion/complete", { ref: { type: "ref/prompt", name: "p" }, argument: { name: "a", value: "" }, _meta: META }, 3));

        expect(recorder.seen).toEqual([
            { op: "prompt", request: { requestId: 2, method: "prompts/get", meta: META } },
            { op: "complete", request: { requestId: 3, method: "completion/complete", meta: META } },
        ]);
    });

    it("leaves meta out when the request carried none, or one that is not an object", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.toolsCallAsync(req("tools/call", { name: "rec_do" }));
        await server.toolsCallAsync(req("tools/call", { name: "rec_do", _meta: ["not", "an", "object"] }));
        await server.toolsCallAsync(req("tools/call", { name: "rec_do", _meta: null }));

        expect(recorder.seen).toHaveLength(3);
        for (const { request } of recorder.seen) {
            expect(request).toEqual({ requestId: 1, method: "tools/call" });
            expect(request && "meta" in request).toBe(false);
        }
    });

    it("is frozen, so one adapter cannot change what another sees", async () => {
        const recorder = new RecordingAdapter();
        const server = await serve(new RecordingBehavior(recorder));

        await server.toolsCallAsync(req("tools/call", { name: "rec_do", _meta: { k: 1 } }));
        const request = recorder.seen[0]!.request!;

        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.meta)).toBe(true);
    });

    it("leaves an adapter written for 1.3.0 working unchanged", async () => {
        const server = await serve(new LegacyBehavior());

        const call = await server.toolsCallAsync(req("tools/call", { name: "legacy_do", arguments: { a: 1 }, _meta: META }));
        const read = await server.resourcesRead(req("resources/read", { uri: "legacy://item/1", _meta: META }));

        expect(call.error).toBeUndefined();
        expect((call.result as { isError?: boolean }).isError).not.toBe(true);
        expect((read.result as { contents: { text: string }[] }).contents[0]?.text).toBe("legacy");
    });
});
