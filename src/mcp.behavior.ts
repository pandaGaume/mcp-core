/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    createEventEmitter,
    IEventEmitter,
    IEventSource,
    IMcpBehaviorAdapter,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpTool,
    McpToolResult,
    ToolSupport,
} from "./interfaces";
import { McpBehaviorBase, McpBehaviorOptions } from "./mcp.behaviorBase";
import type { McpGrammar } from "./mcp.grammar";

export abstract class McpBehavior extends McpBehaviorBase {
    private _resourceCache?: McpResource[];
    private _resourceTemplateCache?: McpResourceTemplate[];
    private _resourceContentCache = new Map<string, McpResourceContent>();
    private _resourceContentPromiseCache = new Map<string, Promise<McpResourceContent | undefined>>();
    private _toolsCache?: McpTool[];
    private _adapter: IMcpBehaviorAdapter;

    /**
     * Memoized result of {@link _buildGrammars}. Invalidated by
     * {@link _invalidateGrammars} when the source data changes (e.g. a
     * subclass hot-reloads its grammar JSONs from disk).
     */
    private _grammarsCache?: ReadonlyMap<string, McpGrammar>;

    /**
     * Event source the server subscribes to so it can re-merge the session
     * grammar and emit `notifications/tools/list_changed`. Lazily created
     * so behaviors that never invalidate pay nothing.
     */
    private _onGrammarsChanged?: IEventEmitter<void>;

    public constructor(adapter: IMcpBehaviorAdapter, options: McpBehaviorOptions) {
        super(options);
        this._adapter = adapter;
    }

    protected get adapter(): IMcpBehaviorAdapter {
        return this._adapter;
    }

    // ── Grammar ──────────────────────────────────────────────────────────────

    /**
     * Subclasses override to declare every grammar key the behavior ships
     * as its own baseline. The default implementation returns an empty
     * map; the behavior then has no structured grammar and the server
     * falls back to the inline strings produced by {@link _buildTools}.
     *
     * Called lazily on the first {@link getGrammar} / {@link listGrammarKeys}
     * invocation and cached until {@link _invalidateGrammars} is called.
     *
     * @example
     * protected override _buildGrammars(): Map<string, McpGrammar> {
     *     return new Map([
     *         ["default:en", McpGrammar.fromJSON(enData)],
     *         ["default:fr", McpGrammar.fromJSON(frData)],
     *         ["claude:fr",  McpGrammar.fromJSON(frTunedForClaude)],
     *     ]);
     * }
     */
    protected _buildGrammars(): Map<string, McpGrammar> {
        return new Map();
    }

    private _getGrammarsMap(): ReadonlyMap<string, McpGrammar> {
        if (!this._grammarsCache) this._grammarsCache = this._buildGrammars();
        return this._grammarsCache;
    }

    /** Returns the behavior-owned grammar for `key`, or `undefined`. */
    public getGrammar(key: string): McpGrammar | undefined {
        return this._getGrammarsMap().get(key);
    }

    /** Every grammar key this behavior declares. */
    public listGrammarKeys(): ReadonlyArray<string> {
        return [...this._getGrammarsMap().keys()];
    }

    /**
     * Drops the cached grammar map and the cached tools list. Call when
     * the source data backing {@link _buildGrammars} changes (e.g. a JSON
     * file was reloaded from disk). The server picks up the change via
     * {@link onGrammarsChanged} and re-merges the session grammar.
     */
    protected _invalidateGrammars(): void {
        this._grammarsCache = undefined;
        this._toolsCache = undefined;
        this._onGrammarsChanged?.emit();
    }

    /**
     * Fires whenever {@link _invalidateGrammars} is called. The server
     * subscribes to re-merge the active session grammar and notify
     * connected clients (`tools/list_changed`).
     */
    public get onGrammarsChanged(): IEventSource<void> {
        if (!this._onGrammarsChanged) this._onGrammarsChanged = createEventEmitter<void>();
        return this._onGrammarsChanged;
    }

    // ── Description fallback hooks ───────────────────────────────────────────

    /**
     * Returns the fallback description for a tool. The behavior's
     * structured baseline now comes from {@link _buildGrammars}; this
     * hook is preserved for source compatibility with subclasses that
     * override it. Default implementation returns the inline fallback.
     */
    protected _resolveToolDescription(_toolName: string, fallback: string): string {
        return fallback;
    }

    /**
     * Returns the fallback description for a tool property. The
     * behavior's structured baseline now comes from {@link _buildGrammars};
     * this hook is preserved for source compatibility. Default
     * implementation returns the inline fallback.
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
        // behavior root uri, build own resource content (cached)
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

        // specific instance uri, delegate to adapter
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
