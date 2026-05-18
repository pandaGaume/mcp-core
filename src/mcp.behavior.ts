/* eslint-disable @typescript-eslint/no-explicit-any */
import { IMcpBehaviorAdapter, McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult, ToolSupport } from "./interfaces";
import { McpBehaviorBase, McpBehaviorOptions } from "./mcp.behaviorBase";

export abstract class McpBehavior extends McpBehaviorBase {
    private _resourceCache?: McpResource[];
    private _resourceTemplateCache?: McpResourceTemplate[];
    private _resourceContentCache = new Map<string, McpResourceContent>();
    private _resourceContentPromiseCache = new Map<string, Promise<McpResourceContent | undefined>>();
    private _toolsCache?: McpTool[];
    private _adapter: IMcpBehaviorAdapter;

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions) {
        super(options);
        this._adapter = adapter;
    }

    protected get adapter(): IMcpBehaviorAdapter {
        return this._adapter;
    }

    // ── Grammar helpers ──────────────────────────────────────────────────────

    /**
     * Returns the fallback description for a tool.
     * Grammar overrides are applied at the server level per session — behaviours
     * only provide the baseline fallback strings.
     */
    protected _resolveToolDescription(_toolName: string, fallback: string): string {
        return fallback;
    }

    /**
     * Returns the fallback description for a tool property.
     * Grammar overrides are applied at the server level per session — behaviours
     * only provide the baseline fallback strings.
     */
    protected _resolvePropertyDescription(_toolName: string, _propertyName: string, fallback: string): string {
        return fallback;
    }

    // ── Resources ────────────────────────────────────────────────────────────

    public override getResources(): McpResource[] {
        if (this._resourceCache) {
            return this._resourceCache;
        }
        this._resourceCache = this._buildResources();
        return this._resourceCache;
    }

    public override getResourceTemplates(): McpResourceTemplate[] {
        if (this._resourceTemplateCache) {
            return this._resourceTemplateCache;
        }
        this._resourceTemplateCache = this._buildTemplate();
        return this._resourceTemplateCache;
    }

    /**
     * Returns the tool schemas exposed by this behavior, filtered by the
     * adapter's declared support level.
     *
     * Tools where the adapter returns {@link ToolSupport.Planned} or
     * {@link ToolSupport.None} are excluded from the advertised list.
     * Tools not in the adapter's support map (returns `undefined`) are
     * treated as {@link ToolSupport.Full} for backwards compatibility.
     */
    public override getTools(): McpTool[] {
        if (this._toolsCache) {
            return this._toolsCache;
        }
        const allTools = this._buildTools();
        this._toolsCache = allTools.filter((tool) => {
            const level = this._adapter.getToolSupport?.(tool.name);
            // undefined → Full (default). Full/Partial → expose. Planned/None → hide.
            return !level || level === ToolSupport.Full || level === ToolSupport.Partial;
        });
        return this._toolsCache;
    }

    public override async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        // behavior root uri — build own resource content (cached)
        const rootUri = this.getResources()[0]?.uri;
        if (uri === rootUri) {
            if (this._resourceContentCache.has(uri)) {
                return this._resourceContentCache.get(uri)!;
            }

            // coalesce concurrent requests for the same uri into one promise
            if (this._resourceContentPromiseCache.has(uri)) {
                return this._resourceContentPromiseCache.get(uri)!;
            }

            const promise = this._buildResourceContentAsync(uri).then((content) => {
                if (content) {
                    this._resourceContentCache.set(uri, content);
                }
                this._resourceContentPromiseCache.delete(uri);
                return content;
            });

            this._resourceContentPromiseCache.set(uri, promise);
            return promise;
        }

        // specific instance uri — delegate to adapter
        return this._adapter.readResourceAsync(uri);
    }

    public override async executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        return this._adapter.executeToolAsync(uri, toolName, args);
    }

    protected _buildResources(): McpResource[] {
        return [];
    }

    protected _buildTemplate(): McpResourceTemplate[] {
        return [];
    }

    protected async _buildResourceContentAsync(uri: string): Promise<McpResourceContent | undefined> {
        return await this.adapter.readResourceAsync(uri);
    }

    protected _buildTools(): McpTool[] {
        return [];
    }
}
