import { describe, expect, it } from "vitest";
import {
    LoopbackTransport,
    MCP_LATEST_PROTOCOL_VERSION,
    MCP_SERVER_NOTIFICATION_METHODS,
    MCP_SERVER_REQUEST_METHODS,
    MCP_SERVER_UNSUPPORTED_METHODS,
    MCP_SUPPORTED_PROTOCOL_VERSIONS,
    McpServerBuilder,
    serverRequestMethodsFor,
} from "../src";
import type { IMcpBehavior, McpPrompt, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

/**
 * Holds the server to the spec's method list.
 *
 * `resources/subscribe`, `resources/unsubscribe`, `prompts/*`,
 * `completion/complete` and `logging/setLevel` were all in the spec from its
 * first revision and all answered `-32601` here until this test existed. It
 * fails when a method the spec lists is neither implemented nor declared
 * unsupported with a reason, so the next gap is caught when the table is
 * updated for a new revision, not by a user.
 */

/** A behavior that exercises every optional feature, so nothing is `-32601` for lack of content. */
class EverythingBehavior implements IMcpBehavior {
    readonly namespace = "all";
    getResources(): McpResource[] {
        return [{ uri: "all://r", name: "r" }];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [{ uriTemplate: "all://t/{id}", name: "t" }];
    }
    getTools(): McpTool[] {
        return [{ name: "noop", inputSchema: { type: "object" } }];
    }
    getPrompts(): McpPrompt[] {
        return [{ name: "p" }];
    }
    async getPromptAsync() {
        return { messages: [] };
    }
    async completeAsync() {
        return { values: [] };
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return { uri, text: "" };
    }
    async executeToolAsync(): Promise<McpToolResult> {
        return { content: [] };
    }
}

/** Plausible params per method, so a reply is about the method, not about missing input. */
const PARAMS: Record<string, unknown> = {
    initialize: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION, clientInfo: { name: "c", version: "0" }, capabilities: {} },
    "resources/read": { uri: "all://r" },
    "resources/subscribe": { uri: "all://r" },
    "resources/unsubscribe": { uri: "all://r" },
    "prompts/get": { name: "p" },
    "tools/call": { name: "noop", arguments: {} },
    "completion/complete": { ref: { type: "ref/prompt", name: "p" }, argument: { name: "a", value: "" } },
    "logging/setLevel": { level: "info" },
    "tasks/get": { taskId: "t" },
    "tasks/result": { taskId: "t" },
    "tasks/cancel": { taskId: "t" },
};

/** Sends raw frames to a started server and collects every frame it sends back. */
async function rawServer() {
    const [serverEnd, peer] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName("s").withTransport(serverEnd).withOptions({ logging: true }).register(new EverythingBehavior()).build();
    const replies: Record<string, unknown>[] = [];
    peer.onMessage = (data) => replies.push(JSON.parse(data));
    await server.start();
    return {
        replies,
        async send(frame: Record<string, unknown>) {
            peer.send(JSON.stringify({ jsonrpc: "2.0", ...frame }));
            // Handlers are async; two macrotasks cover a handler that awaits once.
            await new Promise((r) => setTimeout(r, 0));
            await new Promise((r) => setTimeout(r, 0));
        },
    };
}

describe("spec coverage", () => {
    it("lists a method table for every revision the package speaks", () => {
        for (const revision of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
            expect(MCP_SERVER_REQUEST_METHODS, `revision ${revision}`).toHaveProperty(revision);
        }
    });

    it("answers every request method of the latest revision, or declares it unsupported", async () => {
        const { replies, send } = await rawServer();
        const methods = serverRequestMethodsFor(MCP_LATEST_PROTOCOL_VERSION);
        let id = 1;
        const missing: string[] = [];
        const wronglyDeclared: string[] = [];

        for (const method of methods) {
            replies.length = 0;
            await send({ id: id++, method, params: PARAMS[method] });
            const reply = replies.find((r) => "id" in r) as { error?: { code: number } } | undefined;
            expect(reply, `no reply to ${method}`).toBeDefined();
            const notFound = reply?.error?.code === -32601;
            const declared = method in MCP_SERVER_UNSUPPORTED_METHODS;
            if (notFound && !declared) missing.push(method);
            if (!notFound && declared) wronglyDeclared.push(method);
        }

        expect(missing, "spec methods answered -32601 without a declared reason").toEqual([]);
        expect(wronglyDeclared, "methods declared unsupported that are in fact handled").toEqual([]);
    });

    it("never answers a client notification", async () => {
        const { replies, send } = await rawServer();
        for (const method of MCP_SERVER_NOTIFICATION_METHODS) {
            await send({ method, params: {} });
        }
        expect(replies.filter((r) => "id" in r)).toEqual([]);
    });
});
