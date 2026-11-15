import type { IMcpClient, McpTool, McpToolResult } from "../interfaces";
import { McpToolResults } from "../mcp.toolResult";
import { isWebMcpToolName, toWebMcpAnnotations, toWebMcpResult } from "./webmcp.mapping";
import { getModelContext, WebMcpModelContext, WebMcpToolDefinition } from "./webmcp.types";

/** Options accepted by {@link WebMcpExporter}. */
export interface WebMcpExporterOptions {
    /** The registry to publish into. Defaults to `document.modelContext`. */
    modelContext?: WebMcpModelContext;

    /** Other origins allowed to see and call the published tools (WebMCP `exposedTo`). */
    exposedTo?: string[];

    /** Publishes only the tools it accepts. Defaults to every tool. */
    filter?: (tool: McpTool) => boolean;

    /** Turns an MCP result into what the agent receives. Defaults to {@link toWebMcpResult}. */
    formatResult?: (result: McpToolResult, tool: McpTool) => unknown;

    /**
     * Called for a tool that could not be published (an invalid name, a name
     * another script already registered) or a list that could not be read.
     * Defaults to `console.warn`.
     */
    onError?: (error: Error) => void;
}

interface IPublished {
    readonly key: string;
    readonly controller: AbortController;
}

/**
 * Publishes the tools of an MCP server to the browser's agent through WebMCP.
 *
 * Talks to the server only through an {@link IMcpClient}, normally over a
 * `LoopbackTransport` pair: grammars, `ToolSupport` filtering, routing by
 * `uri` and `isError` results all apply exactly as for any other client.
 * Every `notifications/tools/list_changed` re-reads the list; a tool that
 * disappeared is unregistered, a changed one is registered again.
 *
 * Only tools cross over: WebMCP has no resources, prompts or notifications.
 * Cancellation is not forwarded yet, so a call the agent cancels still runs
 * to completion on the server; its result is discarded by the browser.
 *
 * @example
 * ```typescript
 * const [serverEnd, clientEnd] = LoopbackTransport.createPair();
 * const server = new McpServerBuilder().withName("plant").withTransport(serverEnd).register(gauge).build();
 * await server.start();
 * const exporter = new WebMcpExporter(new McpClient({ name: "webmcp", version: "1.0.0" }, clientEnd));
 * await exporter.start();
 * ```
 */
export class WebMcpExporter {
    private readonly _client: IMcpClient;
    private readonly _options: WebMcpExporterOptions;
    private readonly _published = new Map<string, IPublished>();
    private _context?: WebMcpModelContext;
    private _unsubscribe?: () => void;
    private _sync: Promise<void> = Promise.resolve();
    private _running = false;

    public constructor(client: IMcpClient, options: WebMcpExporterOptions = {}) {
        this._client = client;
        this._options = options;
    }

    /** Names of the tools currently published. */
    public get publishedTools(): string[] {
        return [...this._published.keys()];
    }

    /**
     * Connects the client when it is not connected yet, publishes the current
     * tools, and follows the server's list changes until {@link stop}.
     *
     * @throws when WebMCP is not available in this document.
     */
    public async start(): Promise<void> {
        if (this._running) return this._sync;
        const context = this._options.modelContext ?? getModelContext();
        if (!context) throw new Error("WebMcpExporter: WebMCP is not available here (document.modelContext is missing)");
        this._context = context;
        this._running = true;
        if (!this._client.isConnected) await this._client.connect();
        this._unsubscribe = this._client.onToolsChanged?.subscribe(() => void this.refresh());
        await this.refresh();
    }

    /** Unregisters every published tool and stops following the server. The client stays connected. */
    public stop(): void {
        this._running = false;
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        for (const entry of this._published.values()) entry.controller.abort();
        this._published.clear();
    }

    /**
     * Re-reads the server's tools and brings the registry in line. Runs after
     * any refresh already in progress, so two list changes never interleave.
     */
    public refresh(): Promise<void> {
        this._sync = this._sync.then(() => this._reconcile());
        return this._sync;
    }

    private async _reconcile(): Promise<void> {
        const context = this._context;
        if (!this._running || !context) return;

        let tools: McpTool[];
        try {
            tools = await this._client.listTools();
        } catch (error) {
            this._report(new Error(`WebMcpExporter: tools/list failed, ${describe(error)}`));
            return;
        }
        if (!this._running) return;

        const filter = this._options.filter;
        const wanted = new Map<string, McpTool>();
        for (const tool of tools) if (!filter || filter(tool)) wanted.set(tool.name, tool);

        for (const [name, entry] of this._published) {
            const tool = wanted.get(name);
            if (!tool || keyOf(tool) !== entry.key) {
                entry.controller.abort();
                this._published.delete(name);
            }
        }

        for (const tool of wanted.values()) {
            if (this._published.has(tool.name)) continue;
            if (!isWebMcpToolName(tool.name)) {
                this._report(new Error(`WebMcpExporter: "${tool.name}" is not a valid WebMCP tool name (1 to 128 of A-Z a-z 0-9 _ - .), not published`));
                continue;
            }
            const controller = new AbortController();
            try {
                await context.registerTool(this._definition(tool), { signal: controller.signal, ...(this._options.exposedTo ? { exposedTo: this._options.exposedTo } : {}) });
                if (!this._running) {
                    // stop() ran while this registration was in flight.
                    controller.abort();
                    return;
                }
                this._published.set(tool.name, { key: keyOf(tool), controller });
            } catch (error) {
                this._report(new Error(`WebMcpExporter: registering "${tool.name}" failed, ${describe(error)}`));
            }
        }
    }

    private _definition(tool: McpTool): WebMcpToolDefinition {
        const format = this._options.formatResult ?? toWebMcpResult;
        const definition: WebMcpToolDefinition = {
            name: tool.name,
            description: tool.description || tool.title || tool.name,
            inputSchema: tool.inputSchema,
            execute: async (input) => {
                let result: McpToolResult;
                try {
                    result = await this._client.callTool(tool.name, input ?? {});
                } catch (error) {
                    // A protocol error (unknown tool, bad params) is returned
                    // as a tool error, so the agent reads it instead of a bare
                    // OperationError.
                    result = McpToolResults.error(describe(error));
                }
                return format(result, tool);
            },
        };
        const title = tool.title ?? tool.annotations?.title;
        if (title) definition.title = title;
        if (tool.outputSchema) definition.outputSchema = tool.outputSchema;
        const annotations = toWebMcpAnnotations(tool.annotations);
        if (annotations) definition.annotations = annotations;
        return definition;
    }

    private _report(error: Error): void {
        // eslint-disable-next-line no-console
        (this._options.onError ?? ((e: Error) => console.warn(e.message)))(error);
    }
}

/** What decides whether a published tool must be registered again. */
function keyOf(tool: McpTool): string {
    return JSON.stringify([tool.title, tool.description, tool.inputSchema, tool.outputSchema, tool.annotations]);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
