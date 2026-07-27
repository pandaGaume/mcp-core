/**
 * Serialisable grammar layer that holds description overrides for tools,
 * resources, and resource templates exposed by an MCP server. Editable at
 * runtime and round-tripped to/from JSON.
 *
 * The MCP behaviour uses up to two grammar layers (highest priority first):
 * 1. **Runtime grammar**: loaded from JSON, set via API.
 * 2. **Adapter grammar**: engine-specific, supplied by the application binding.
 *
 * If neither layer provides a value, the behaviour falls back to the inline
 * default string supplied at each call site.
 *
 * Each layer is an `McpGrammar` instance. At resolution time the behaviour
 * walks the layers top-down and returns the first non-`undefined` value.
 */

// ── Serialisation shapes ─────────────────────────────────────────────────────

/** Describes one tool inside a serialised grammar. */
export type McpGrammarToolEntry = {
    /** Override for the tool's display title (what a UI shows instead of the name). */
    title?: string;
    /** Tool-level description (what the tool does). */
    description?: string;
    /** Per-property descriptions keyed by property name (supports dot-notation, e.g. "patch.position"). */
    properties?: Record<string, string>;
};

/** Describes one resource inside a serialised grammar. */
export type McpGrammarResourceEntry = {
    /** Override for the resource's programmatic name. */
    name?: string;
    /** Override for the resource's display title. */
    title?: string;
    /** Override for the resource's description. */
    description?: string;
};

/** Describes one resource template inside a serialised grammar. */
export type McpGrammarTemplateEntry = {
    /** Override for the template's programmatic name. */
    name?: string;
    /** Override for the template's display title. */
    title?: string;
    /** Override for the template's description. */
    description?: string;
};

/**
 * Plain JSON-safe object that can be persisted / transmitted.
 *
 * Two shapes are accepted by {@link McpGrammar.fromJSON}:
 *
 * 1. **Modern (recommended)** — top-level keyed by category:
 * ```json
 * {
 *     "tools":      { "tool_a": { "description": "...", "properties": { "x": "..." } } },
 *     "resources":  { "scheme://uri": { "name": "...", "description": "..." } },
 *     "templates":  { "scheme://path/{var}": { "name": "...", "description": "..." } }
 * }
 * ```
 *
 * 2. **Legacy (still accepted, tools-only)** — top-level keyed by tool name,
 *    with no `tools`/`resources`/`templates` wrappers. This was the v0.1
 *    shape; new code should prefer the modern shape.
 *
 * {@link McpGrammar.toJSON} always emits the modern shape.
 */
export type McpGrammarData = {
    tools?: Record<string, McpGrammarToolEntry>;
    resources?: Record<string, McpGrammarResourceEntry>;
    templates?: Record<string, McpGrammarTemplateEntry>;
};

/** @deprecated Use {@link McpGrammarData}. Kept for v0.1 callers. */
export type McpGrammarLegacyData = Record<string, McpGrammarToolEntry>;

// ── Grammar class ────────────────────────────────────────────────────────────

export class McpGrammar {
    private _tools = new Map<string, McpGrammarToolEntry>();
    private _resources = new Map<string, McpGrammarResourceEntry>();
    private _templates = new Map<string, McpGrammarTemplateEntry>();

    // ── Construction ─────────────────────────────────────────────────────────

    constructor(data?: McpGrammarData | McpGrammarLegacyData) {
        if (!data) return;

        if (McpGrammar._isModernShape(data)) {
            const m = data as McpGrammarData;
            if (m.tools) {
                for (const [k, v] of Object.entries(m.tools)) this._tools.set(k, McpGrammar._cloneToolEntry(v));
            }
            if (m.resources) {
                for (const [k, v] of Object.entries(m.resources)) this._resources.set(k, McpGrammar._cloneResourceEntry(v));
            }
            if (m.templates) {
                for (const [k, v] of Object.entries(m.templates)) this._templates.set(k, McpGrammar._cloneTemplateEntry(v));
            }
        } else {
            // Legacy flat shape: top-level keyed by tool name.
            for (const [k, v] of Object.entries(data as McpGrammarLegacyData)) {
                this._tools.set(k, McpGrammar._cloneToolEntry(v));
            }
        }
    }

    private static _isModernShape(data: McpGrammarData | McpGrammarLegacyData): boolean {
        const d = data as McpGrammarData;
        return (
            (typeof d.tools === "object" && d.tools !== null) ||
            (typeof d.resources === "object" && d.resources !== null) ||
            (typeof d.templates === "object" && d.templates !== null)
        );
    }

    // ── Tool title / description ─────────────────────────────────────────────

    getToolTitle(toolName: string): string | undefined {
        return this._tools.get(toolName)?.title;
    }

    setToolTitle(toolName: string, title: string): void {
        const entry = this._ensureToolEntry(toolName);
        entry.title = title;
    }

    getToolDescription(toolName: string): string | undefined {
        return this._tools.get(toolName)?.description;
    }

    setToolDescription(toolName: string, description: string): void {
        const entry = this._ensureToolEntry(toolName);
        entry.description = description;
    }

    // ── Tool property description ────────────────────────────────────────────

    getPropertyDescription(toolName: string, propertyName: string): string | undefined {
        return this._tools.get(toolName)?.properties?.[propertyName];
    }

    setPropertyDescription(toolName: string, propertyName: string, description: string): void {
        const entry = this._ensureToolEntry(toolName);
        if (!entry.properties) entry.properties = {};
        entry.properties[propertyName] = description;
    }

    // ── Resource name / title / description ──────────────────────────────────

    getResourceName(uri: string): string | undefined {
        return this._resources.get(uri)?.name;
    }

    setResourceName(uri: string, name: string): void {
        const entry = this._ensureResourceEntry(uri);
        entry.name = name;
    }

    getResourceTitle(uri: string): string | undefined {
        return this._resources.get(uri)?.title;
    }

    setResourceTitle(uri: string, title: string): void {
        const entry = this._ensureResourceEntry(uri);
        entry.title = title;
    }

    getResourceDescription(uri: string): string | undefined {
        return this._resources.get(uri)?.description;
    }

    setResourceDescription(uri: string, description: string): void {
        const entry = this._ensureResourceEntry(uri);
        entry.description = description;
    }

    // ── Resource template name / title / description ─────────────────────────

    getResourceTemplateName(uriTemplate: string): string | undefined {
        return this._templates.get(uriTemplate)?.name;
    }

    setResourceTemplateName(uriTemplate: string, name: string): void {
        const entry = this._ensureTemplateEntry(uriTemplate);
        entry.name = name;
    }

    getResourceTemplateTitle(uriTemplate: string): string | undefined {
        return this._templates.get(uriTemplate)?.title;
    }

    setResourceTemplateTitle(uriTemplate: string, title: string): void {
        const entry = this._ensureTemplateEntry(uriTemplate);
        entry.title = title;
    }

    getResourceTemplateDescription(uriTemplate: string): string | undefined {
        return this._templates.get(uriTemplate)?.description;
    }

    setResourceTemplateDescription(uriTemplate: string, description: string): void {
        const entry = this._ensureTemplateEntry(uriTemplate);
        entry.description = description;
    }

    // ── Serialisation ────────────────────────────────────────────────────────

    /** Returns a plain JSON-safe snapshot of this grammar in the modern shape. */
    toJSON(): McpGrammarData {
        const out: McpGrammarData = {};

        if (this._tools.size > 0) {
            out.tools = {};
            for (const [k, v] of this._tools) out.tools[k] = McpGrammar._cloneToolEntry(v);
        }
        if (this._resources.size > 0) {
            out.resources = {};
            for (const [k, v] of this._resources) out.resources[k] = McpGrammar._cloneResourceEntry(v);
        }
        if (this._templates.size > 0) {
            out.templates = {};
            for (const [k, v] of this._templates) out.templates[k] = McpGrammar._cloneTemplateEntry(v);
        }

        return out;
    }

    /**
     * Constructs a grammar from a plain JSON object. Accepts both the modern
     * shape (`{ tools, resources, templates }`) and the legacy tools-only flat
     * shape (`{ "<toolName>": { description, properties } }`).
     */
    static fromJSON(data: McpGrammarData | McpGrammarLegacyData): McpGrammar {
        return new McpGrammar(data);
    }

    // ── Merge ────────────────────────────────────────────────────────────────

    /**
     * Creates a new grammar by overlaying entries from left to right.
     * Later grammars win. `undefined` entries in a later grammar do NOT erase
     * entries from earlier grammars — only explicit strings override.
     */
    static merge(...grammars: (McpGrammar | undefined)[]): McpGrammar {
        const result = new McpGrammar();
        for (const g of grammars) {
            if (!g) continue;

            // Tools
            for (const [toolName, src] of g._tools) {
                const dest = result._ensureToolEntry(toolName);
                if (src.title !== undefined) dest.title = src.title;
                if (src.description !== undefined) dest.description = src.description;
                if (src.properties) {
                    if (!dest.properties) dest.properties = {};
                    for (const [prop, desc] of Object.entries(src.properties)) {
                        dest.properties[prop] = desc;
                    }
                }
            }

            // Resources
            for (const [uri, src] of g._resources) {
                const dest = result._ensureResourceEntry(uri);
                if (src.name !== undefined) dest.name = src.name;
                if (src.title !== undefined) dest.title = src.title;
                if (src.description !== undefined) dest.description = src.description;
            }

            // Templates
            for (const [tpl, src] of g._templates) {
                const dest = result._ensureTemplateEntry(tpl);
                if (src.name !== undefined) dest.name = src.name;
                if (src.title !== undefined) dest.title = src.title;
                if (src.description !== undefined) dest.description = src.description;
            }
        }
        return result;
    }

    // ── Clone ────────────────────────────────────────────────────────────────

    clone(): McpGrammar {
        return new McpGrammar(this.toJSON());
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private _ensureToolEntry(toolName: string): McpGrammarToolEntry {
        let entry = this._tools.get(toolName);
        if (!entry) {
            entry = {};
            this._tools.set(toolName, entry);
        }
        return entry;
    }

    private _ensureResourceEntry(uri: string): McpGrammarResourceEntry {
        let entry = this._resources.get(uri);
        if (!entry) {
            entry = {};
            this._resources.set(uri, entry);
        }
        return entry;
    }

    private _ensureTemplateEntry(uriTemplate: string): McpGrammarTemplateEntry {
        let entry = this._templates.get(uriTemplate);
        if (!entry) {
            entry = {};
            this._templates.set(uriTemplate, entry);
        }
        return entry;
    }

    private static _cloneToolEntry(entry: McpGrammarToolEntry): McpGrammarToolEntry {
        const clone: McpGrammarToolEntry = {};
        if (entry.title !== undefined) clone.title = entry.title;
        if (entry.description !== undefined) clone.description = entry.description;
        if (entry.properties) clone.properties = { ...entry.properties };
        return clone;
    }

    private static _cloneResourceEntry(entry: McpGrammarResourceEntry): McpGrammarResourceEntry {
        const clone: McpGrammarResourceEntry = {};
        if (entry.name !== undefined) clone.name = entry.name;
        if (entry.title !== undefined) clone.title = entry.title;
        if (entry.description !== undefined) clone.description = entry.description;
        return clone;
    }

    private static _cloneTemplateEntry(entry: McpGrammarTemplateEntry): McpGrammarTemplateEntry {
        const clone: McpGrammarTemplateEntry = {};
        if (entry.name !== undefined) clone.name = entry.name;
        if (entry.title !== undefined) clone.title = entry.title;
        if (entry.description !== undefined) clone.description = entry.description;
        return clone;
    }
}
