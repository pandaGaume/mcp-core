import { describe, expect, it } from "vitest";
import {
    actionMetadataOf,
    appsClientCapabilities,
    clientRendersApps,
    isModelVisible,
    LoopbackTransport,
    MCP_APP_MIME_TYPE,
    McpAppsExtension,
    McpClient,
    McpServerBuilder,
    toolNeedsReview,
    trustAnnotationsOf,
    uiOf,
    uiResource,
    uiResourceContent,
    withActionMetadata,
    withoutUi,
    withTrustAnnotations,
    withUi,
} from "../src";
import type { IMcpBehavior, McpClientCapabilities, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

const base: McpTool = { name: "set_valve", inputSchema: { type: "object" } };

describe("action metadata and trust annotations", () => {
    it("puts action metadata under its extension key in the annotations", () => {
        const tool = withActionMetadata({ ...base, annotations: { destructiveHint: true } }, { outcome: "irreversible", inputMetadata: { destination: "internal" } });
        expect(tool.annotations?.destructiveHint).toBe(true);
        expect(tool.annotations?.["io.modelcontextprotocol/action-metadata"]).toEqual({ outcome: "irreversible", inputMetadata: { destination: "internal" } });
        expect(actionMetadataOf(tool)?.outcome).toBe("irreversible");
        expect(base.annotations).toBeUndefined();
    });

    it("asks for review on requiresReview or an irreversible outcome, not otherwise", () => {
        expect(toolNeedsReview(withActionMetadata(base, { requiresReview: true }))).toBe(true);
        expect(toolNeedsReview(withActionMetadata(base, { outcome: "irreversible" }))).toBe(true);
        expect(toolNeedsReview(withActionMetadata(base, { outcome: "consequential" }))).toBe(false);
        expect(toolNeedsReview(base)).toBe(false);
    });

    it("merges result and block trust annotations without weakening, and keeps absence as no claim", () => {
        const result: McpToolResult = withTrustAnnotations(
            {
                content: [
                    { type: "text", text: "a", _meta: { "io.modelcontextprotocol/trust-annotations": { untrusted: true, sensitive: false } } },
                    { type: "text", text: "b" },
                ],
            },
            { sensitive: true }
        );
        expect(trustAnnotationsOf(result)).toEqual({ sensitive: true, untrusted: true });
        expect(trustAnnotationsOf({ content: [{ type: "text", text: "plain" }] })).toBeUndefined();
        const onlyFalse = trustAnnotationsOf({ content: [], _meta: { "io.modelcontextprotocol/trust-annotations": { sensitive: false } } });
        expect(onlyFalse).toEqual({ sensitive: false });
        expect(onlyFalse?.untrusted).toBeUndefined();
    });
});

describe("MCP Apps helpers", () => {
    it("attaches _meta.ui, refuses a non-ui:// resource, and reads visibility", () => {
        const tool = withUi(base, { resourceUri: "ui://scada/valve" });
        expect(uiOf(tool)).toEqual({ resourceUri: "ui://scada/valve" });
        expect(isModelVisible(tool)).toBe(true);
        expect(isModelVisible(withUi(base, { visibility: ["app"] }))).toBe(false);
        expect(() => withUi(base, { resourceUri: "https://example.com/x" })).toThrow(/not a ui:\/\//);
        expect(() => uiResource("ui://", "empty")).toThrow();
    });

    it("strips the UI for a client that cannot render it and drops app-only tools", () => {
        const withOther = withUi({ ...base, _meta: { keep: 1 } }, { resourceUri: "ui://a" });
        expect(withoutUi(withOther)).toEqual({ ...base, _meta: { keep: 1 } });
        expect(withoutUi(withUi(base, { resourceUri: "ui://a" }))).toEqual(base);
        expect(withoutUi(withUi(base, { visibility: ["app"] }))).toBeUndefined();
        expect(withoutUi(base)).toBe(base);
    });

    it("builds UI resources with the MCP App MIME type and recognizes a rendering client", () => {
        expect(uiResource("ui://a", "A", { ui: { prefersBorder: true } })).toEqual({
            uri: "ui://a",
            name: "A",
            mimeType: MCP_APP_MIME_TYPE,
            _meta: { ui: { prefersBorder: true } },
        });
        expect(uiResourceContent("ui://a", "<!doctype html><html></html>")).toEqual({ uri: "ui://a", mimeType: MCP_APP_MIME_TYPE, text: "<!doctype html><html></html>" });
        expect(clientRendersApps(appsClientCapabilities())).toBe(true);
        expect(clientRendersApps({ extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } } })).toBe(false);
        expect(clientRendersApps({})).toBe(false);
    });
});

/** A behavior with a UI tool, an app-only tool and the UI resource behind them. */
class FaceplateBehavior implements IMcpBehavior {
    readonly namespace = "faceplate";
    getResources(): McpResource[] {
        return [uiResource("ui://scada/valve", "valve faceplate")];
    }
    getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    getTools(): McpTool[] {
        return [
            withUi({ name: "read_valve", inputSchema: { type: "object" } }, { resourceUri: "ui://scada/valve" }),
            withUi({ name: "nudge", inputSchema: { type: "object" } }, { visibility: ["app"] }),
        ];
    }
    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return uiResourceContent(uri, "<!doctype html><html><body>valve</body></html>");
    }
    async executeToolAsync(): Promise<McpToolResult> {
        return { content: [{ type: "text", text: "42 %" }] };
    }
}

async function listToolsAs(capabilities: McpClientCapabilities): Promise<McpTool[]> {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder()
        .withTransport(serverEnd)
        .withExtension(new McpAppsExtension({ behaviors: [new FaceplateBehavior()] }))
        .build();
    await server.start();
    const client = new McpClient({ name: "host", version: "1" }, clientEnd, 30_000, { capabilities });
    await client.connect();
    expect(client.serverExtension("io.modelcontextprotocol/ui")).toEqual({});
    const tools = await client.listTools();
    expect((await client.readResource("ui://scada/valve"))?.mimeType).toBe(MCP_APP_MIME_TYPE);
    client.disconnect();
    return tools;
}

describe("McpAppsExtension", () => {
    it("lists UI tools as they are for a host that renders MCP Apps", async () => {
        const tools = await listToolsAs(appsClientCapabilities());
        expect(tools.map((tool) => tool.name)).toEqual(["read_valve", "nudge"]);
        expect(uiOf(tools[0])?.resourceUri).toBe("ui://scada/valve");
    });

    it("hides the UI from a client that does not render it", async () => {
        const tools = await listToolsAs({});
        expect(tools.map((tool) => tool.name)).toEqual(["read_valve"]);
        expect(uiOf(tools[0])).toBeUndefined();
    });
});
