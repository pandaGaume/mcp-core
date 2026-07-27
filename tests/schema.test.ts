import { describe, expect, it } from "vitest";
import { McpServer, McpToolResults } from "../src";
import { Mcp } from "../src/server/jsonrpc.helpers";
import type { IMcpBehavior, JsonRpcRequest, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class SchemaBehavior implements IMcpBehavior {
    readonly namespace = "schema";

    constructor(
        private readonly _resources: McpResource[] = [],
        private readonly _templates: McpResourceTemplate[] = [],
        private readonly _tools: McpTool[] = [],
        private readonly _content?: McpResourceContent
    ) {}

    getResources(): McpResource[] {
        return this._resources;
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return this._templates;
    }
    getTools(): McpTool[] {
        return this._tools;
    }
    async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return this._content;
    }
    async executeToolAsync(_uri: string, _toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        return { content: [] };
    }
}

function request(method: string, params?: unknown): JsonRpcRequest {
    return { jsonrpc: "2.0", id: 1, method, params };
}

// ---------------------------------------------------------------------------
// Resource contents
// ---------------------------------------------------------------------------

describe("resource contents", () => {
    it("serves binary content as blob", async () => {
        const server = new McpServer("s", "", {});
        server.register(
            new SchemaBehavior([{ uri: "app://logo", name: "logo", mimeType: "image/png" }], [], [], {
                uri: "app://logo",
                mimeType: "image/png",
                blob: "aGVsbG8=",
            })
        );

        const res = await server.resourcesRead(request("resources/read", { uri: "app://logo" }));
        const contents = (res.result as { contents: McpResourceContent[] }).contents;

        expect(contents[0]).toEqual({ uri: "app://logo", mimeType: "image/png", blob: "aGVsbG8=" });
        expect("text" in contents[0]).toBe(false);
    });

    it("still serves text content unchanged", async () => {
        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([{ uri: "app://notes", name: "notes" }], [], [], { uri: "app://notes", mimeType: "text/plain", text: "hello" }));

        const res = await server.resourcesRead(request("resources/read", { uri: "app://notes" }));
        const contents = (res.result as { contents: McpResourceContent[] }).contents;
        expect(contents[0]).toEqual({ uri: "app://notes", mimeType: "text/plain", text: "hello" });
    });

    it("narrows on the variant that is present", () => {
        const contents: McpResourceContent[] = [
            { uri: "a", text: "plain" },
            { uri: "b", blob: "YmluYXJ5" },
        ];

        const rendered = contents.map((c) => (c.text !== undefined ? `text:${c.text}` : `blob:${c.blob}`));
        expect(rendered).toEqual(["text:plain", "blob:YmluYXJ5"]);
    });
});

// ---------------------------------------------------------------------------
// Descriptive metadata
// ---------------------------------------------------------------------------

describe("descriptive metadata", () => {
    it("passes tool title, outputSchema, annotations and icons through tools/list", () => {
        const tool: McpTool = {
            name: "get_weather",
            title: "Weather Information Provider",
            description: "Get current weather",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object", properties: { temperature: { type: "number" } } },
            annotations: { readOnlyHint: true, openWorldHint: true },
            icons: [{ src: "https://example.com/i.png", mimeType: "image/png", sizes: ["48x48"] }],
            _meta: { "example.com/owner": "weather-team" },
        };

        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([], [], [tool]));

        const listed = (server.toolsList(request("tools/list")).result as { tools: McpTool[] }).tools;
        expect(listed[0]).toEqual(tool);
    });

    it("accepts a tool with no description, as the spec allows", () => {
        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([], [], [{ name: "ping", inputSchema: { type: "object", additionalProperties: false } }]));

        const listed = (server.toolsList(request("tools/list")).result as { tools: McpTool[] }).tools;
        expect(listed[0].description).toBeUndefined();
    });

    it("passes resource title, size, annotations and icons through resources/list", () => {
        const resource: McpResource = {
            uri: "file:///project/README.md",
            name: "README.md",
            title: "Project Documentation",
            mimeType: "text/markdown",
            size: 1024,
            annotations: { audience: ["user"], priority: 0.8, lastModified: "2025-01-12T15:00:58Z" },
            icons: [{ src: "https://example.com/doc.png" }],
        };

        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([resource]));

        const listed = (server.resourcesList(request("resources/list")).result as { resources: McpResource[] }).resources;
        expect(listed[0]).toEqual(resource);
    });

    it("accepts a resource with no mimeType, as the spec allows", () => {
        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([{ uri: "app://thing", name: "thing" }]));

        const listed = (server.resourcesList(request("resources/list")).result as { resources: McpResource[] }).resources;
        expect(listed[0].mimeType).toBeUndefined();
    });

    it("passes template title and icons through resources/templates/list", () => {
        const template: McpResourceTemplate = {
            uriTemplate: "file:///{path}",
            name: "Project Files",
            title: "📁 Project Files",
            icons: [{ src: "https://example.com/folder.png" }],
        };

        const server = new McpServer("s", "", {});
        server.register(new SchemaBehavior([], [template]));

        const listed = (server.resourcesTemplatesList(request("resources/templates/list")).result as { resourceTemplates: McpResourceTemplate[] }).resourceTemplates;
        expect(listed[0]).toEqual(template);
    });
});

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

describe("tool result content blocks", () => {
    it("builds an audio block", () => {
        expect(McpToolResults.audio("YXVkaW8=", "audio/wav").content[0]).toEqual({ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" });
    });

    it("builds a resource link, with optional descriptive fields", () => {
        expect(McpToolResults.link("mesh://scene/hero", "hero").content[0]).toEqual({ type: "resource_link", uri: "mesh://scene/hero", name: "hero" });

        expect(McpToolResults.link("mesh://scene/hero", "hero", { description: "Main character", mimeType: "model/gltf+json" }).content[0]).toEqual({
            type: "resource_link",
            uri: "mesh://scene/hero",
            name: "hero",
            description: "Main character",
            mimeType: "model/gltf+json",
        });
    });

    it("embeds a blob resource", () => {
        const result = McpToolResults.resource({ uri: "app://logo", mimeType: "image/png", blob: "aGVsbG8=" });
        expect(result.content[0]).toEqual({ type: "resource", resource: { uri: "app://logo", mimeType: "image/png", blob: "aGVsbG8=" } });
    });

    it("forwards _meta on the wire, and omits it when absent", () => {
        const withMeta = Mcp.toolCallResult(1, { content: [{ type: "text", text: "ok" }], _meta: { "example.com/trace": "abc" } });
        expect((withMeta.result as { _meta: unknown })._meta).toEqual({ "example.com/trace": "abc" });

        const withoutMeta = Mcp.toolCallResult(1, { content: [{ type: "text", text: "ok" }] });
        expect(withoutMeta.result as object).not.toHaveProperty("_meta");
    });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("capability shapes", () => {
    it("accepts the full client capability set a modern peer announces", () => {
        const server = new McpServer("s", "", {});
        const res = server.initialize(
            request("initialize", {
                protocolVersion: "2025-11-25",
                clientInfo: { name: "c", version: "1.0.0", title: "Example Client", description: "An example", websiteUrl: "https://example.com" },
                capabilities: {
                    roots: { listChanged: true },
                    sampling: {},
                    elicitation: { form: {}, url: {} },
                    tasks: { requests: { sampling: { createMessage: {} } } },
                    experimental: { somethingNew: { enabled: true } },
                },
            })
        );

        expect(res.error).toBeUndefined();
    });
});
