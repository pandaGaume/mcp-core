import type { IMcpRequestContext, McpResourceContent, McpTool, McpToolResult } from "../interfaces";
import { McpAdapterBase } from "../mcp.adapter";
import { McpBehavior } from "../mcp.behavior";
import type { McpBehaviorOptions } from "../mcp.behaviorBase";
import { McpToolResults } from "../mcp.toolResult";
import { fromWebMcpResult, fromWebMcpTool, isWebMcpToolName } from "./webmcp.mapping";
import { getModelContext, WebMcpModelContext, WebMcpRegisteredTool } from "./webmcp.types";

/** Options accepted by {@link WebMcpAdapter}. */
export interface WebMcpAdapterOptions {
    /** The registry to read from. Defaults to `document.modelContext`. */
    modelContext?: WebMcpModelContext;

    /**
     * Other origins whose tools to include (WebMCP `fromOrigins`), typically
     * cross-origin iframes. Each must also have listed this page's origin in
     * its own `exposedTo`, and the iframe needs `allow="tools"`.
     */
    fromOrigins?: string[];

    /**
     * Re-serves only the tools it accepts. Use it to leave out tools a
     * {@link WebMcpExporter} published from the same server, which would
     * otherwise come back as duplicates.
     */
    filter?: (tool: WebMcpRegisteredTool) => boolean;

    /** Adapter domain. Defaults to `"webmcp"`. */
    domain?: string;

    /** Called for a tool left out (invalid or duplicate name) or a list that could not be read. Defaults to `console.warn`. */
    onError?: (error: Error) => void;
}

/**
 * Reads the tools a page registered with WebMCP and runs them through
 * `executeTool`. Pair it with {@link WebMcpBehavior}.
 *
 * The list is a snapshot, refreshed on every `toolchange` event; each refresh
 * that changes it raises `onToolsChanged`, which becomes
 * `notifications/tools/list_changed` for the MCP client.
 */
export class WebMcpAdapter extends McpAdapterBase {
    private readonly _options: WebMcpAdapterOptions;
    private _context?: WebMcpModelContext;
    private _tools = new Map<string, WebMcpRegisteredTool>();
    private _key = "[]";
    private _sync: Promise<void> = Promise.resolve();
    private readonly _onToolChange = (): void => void this.refresh();

    public constructor(options: WebMcpAdapterOptions = {}) {
        super(options.domain ?? "webmcp");
        this._options = options;
    }

    /** The tools of the last refresh, in registry order. */
    public get tools(): WebMcpRegisteredTool[] {
        return [...this._tools.values()];
    }

    /**
     * Reads the current tools and follows `toolchange` until {@link dispose}.
     * Await it before starting the server, so the first `tools/list` already
     * has them.
     *
     * @throws when WebMCP is not available in this document.
     */
    public async start(): Promise<void> {
        if (!this._context) {
            const context = this._options.modelContext ?? getModelContext();
            if (!context) throw new Error("WebMcpAdapter: WebMCP is not available here (document.modelContext is missing)");
            this._context = context;
            context.addEventListener("toolchange", this._onToolChange);
        }
        await this.refresh();
    }

    /** Re-reads the registry. Runs after any refresh in progress. */
    public refresh(): Promise<void> {
        this._sync = this._sync.then(() => this._reload());
        return this._sync;
    }

    public override dispose(): void {
        this._context?.removeEventListener("toolchange", this._onToolChange);
        this._context = undefined;
        super.dispose();
    }

    public override async readResourceAsync(_uri: string, _request?: IMcpRequestContext): Promise<McpResourceContent | undefined> {
        return undefined;
    }

    public override async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, _request?: IMcpRequestContext): Promise<McpToolResult> {
        const tool = this._tools.get(toolName);
        if (!tool || !this._context) return McpToolResults.error(`WebMCP tool "${toolName}" is no longer registered`);
        try {
            return fromWebMcpResult(await this._context.executeTool(tool, args));
        } catch (error) {
            // WebMCP rejects with a bare OperationError and keeps the page's
            // reason to itself, so this is all there is to tell.
            return McpToolResults.error(`WebMCP tool "${toolName}" failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        }
    }

    private async _reload(): Promise<void> {
        const context = this._context;
        if (!context) return;
        let listed: WebMcpRegisteredTool[];
        try {
            listed = await context.getTools(this._options.fromOrigins ? { fromOrigins: this._options.fromOrigins } : undefined);
        } catch (error) {
            this._report(new Error(`WebMcpAdapter: getTools failed, ${error instanceof Error ? error.message : String(error)}`));
            return;
        }

        const tools = new Map<string, WebMcpRegisteredTool>();
        for (const tool of listed) {
            if (this._options.filter && !this._options.filter(tool)) continue;
            if (!isWebMcpToolName(tool.name)) {
                this._report(new Error(`WebMcpAdapter: "${tool.name}" from ${tool.origin} is not a valid tool name, left out`));
                continue;
            }
            const first = tools.get(tool.name);
            if (first) {
                // Two documents (a page and an iframe, say) chose the same
                // name; MCP has one namespace, so the first keeps it.
                this._report(new Error(`WebMcpAdapter: "${tool.name}" is registered by both ${first.origin} and ${tool.origin}; keeping ${first.origin}`));
                continue;
            }
            tools.set(tool.name, tool);
        }

        const key = JSON.stringify([...tools.values()].map((t) => [t.name, t.origin, t.title, t.description, t.inputSchema, t.outputSchema, t.annotations]));
        this._tools = tools;
        if (key === this._key) return;
        this._key = key;
        this._forwardToolsChanged();
    }

    private _report(error: Error): void {
        // eslint-disable-next-line no-console
        (this._options.onError ?? ((e: Error) => console.warn(e.message)))(error);
    }
}

/**
 * Serves the tools a page registered with WebMCP to an MCP client: an external
 * agent reaching the page through a broker slot, a test, a sibling frame.
 *
 * Its tool set is filled at runtime, so it declares `dynamicTools` and the
 * server advertises `tools` even while the page has registered none yet.
 *
 * @example
 * ```typescript
 * const adapter = new WebMcpAdapter();
 * await adapter.start();
 * const server = new McpServerBuilder().withName("page").withTransport(transport).register(new WebMcpBehavior(adapter)).build();
 * await server.start();
 * ```
 */
export class WebMcpBehavior extends McpBehavior {
    public readonly dynamicTools = true;
    private readonly _webmcp: WebMcpAdapter;

    public constructor(adapter: WebMcpAdapter, options: McpBehaviorOptions = {}) {
        super(adapter, { namespace: "webmcp", name: "WebMCP tools", ...options });
        this._webmcp = adapter;
    }

    protected override _buildTools(): McpTool[] {
        return this._webmcp.tools.map(fromWebMcpTool);
    }
}
