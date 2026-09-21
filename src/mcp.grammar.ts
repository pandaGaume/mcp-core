/**
 * Serialisable grammar layer that holds description overrides for tools,
 * resources, and resource templates exposed by an MCP server, the server's
 * own words, and the free phrases a host says or shows (1.2.0). Editable at
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
 * 1. **Modern (recommended)**, top-level keyed by category:
 * ```json
 * {
 *     "tools":      { "tool_a": { "description": "...", "properties": { "x": "..." } } },
 *     "resources":  { "scheme://uri": { "name": "...", "description": "..." } },
 *     "templates":  { "scheme://path/{var}": { "name": "...", "description": "..." } }
 * }
 * ```
 *
 * 2. **Legacy (still accepted, tools-only)**, top-level keyed by tool name,
 *    with no `tools`/`resources`/`templates` wrappers. This was the v0.1
 *    shape; new code should prefer the modern shape.
 *
 * {@link McpGrammar.toJSON} always emits the modern shape.
 */
/**
 * The server's own words, in one wording: the one-line description a client
 * reads in `serverInfo`, and the usage note it receives in
 * `initialize.instructions`. A grammar file for one audience and one
 * language can therefore carry everything a session reads.
 */
export type McpGrammarServerEntry = {
    description?: string;
    instructions?: string;
};

/**
 * Free sentences in one wording (1.2.0): what a host says or shows that
 * describes no tool, keyed, with `{holes}` filled at use
 * (`"step.fit": "Model fitted on {rows} rows"`). A locale file carries the
 * same keys with the same holes as the reference locale; the server hands a
 * session its phrases as the resource `grammar://phrases`.
 */
export type McpGrammarPhrases = Record<string, string>;

export type McpGrammarData = {
    server?: McpGrammarServerEntry;
    tools?: Record<string, McpGrammarToolEntry>;
    resources?: Record<string, McpGrammarResourceEntry>;
    templates?: Record<string, McpGrammarTemplateEntry>;
    phrases?: McpGrammarPhrases;
};

/** What a grammar names that the surface it describes does not have, or a phrase that differs from the reference wording. */
export type McpGrammarProblem = {
    /** `tool`, `property`, `resource`, `template` or `phrase`. */
    kind: string;
    /** The name the grammar used. */
    name: string;
    message: string;
};

/** The URI under which a server serves the phrases of a session's grammar. */
export const GRAMMAR_PHRASES_URI = "grammar://phrases";

/** A hole in a phrase: `{name}`, letters, digits, `_`, `.`, `-`. */
const HOLE = /\{([a-zA-Z0-9_.-]+)\}/g;

/** The holes a phrase names, sorted, once each. */
export function phraseHoles(template: string): string[] {
    return [...new Set([...template.matchAll(HOLE)].map((m) => m[1]))].sort();
}

/** A phrase with its holes filled from `values`; a hole with no value reads `?`. */
export function fillPhrase(template: string, values: Record<string, unknown> = {}): string {
    return template.replace(HOLE, (_, name: string) => (name in values && values[name] !== undefined ? String(values[name]) : "?"));
}

/** @deprecated Use {@link McpGrammarData}. Kept for v0.1 callers. */
export type McpGrammarLegacyData = Record<string, McpGrammarToolEntry>;

// ── Grammar class ────────────────────────────────────────────────────────────

export class McpGrammar {
    private _server: McpGrammarServerEntry = {};
    private _tools = new Map<string, McpGrammarToolEntry>();
    private _resources = new Map<string, McpGrammarResourceEntry>();
    private _templates = new Map<string, McpGrammarTemplateEntry>();
    private _phrases = new Map<string, string>();

    // ── Construction ─────────────────────────────────────────────────────────

    constructor(data?: McpGrammarData | McpGrammarLegacyData) {
        if (!data) return;

        if (McpGrammar._isModernShape(data)) {
            const m = data as McpGrammarData;
            if (m.server) this._server = { ...m.server };
            if (m.tools) {
                for (const [k, v] of Object.entries(m.tools)) this._tools.set(k, McpGrammar._cloneToolEntry(v));
            }
            if (m.resources) {
                for (const [k, v] of Object.entries(m.resources)) this._resources.set(k, McpGrammar._cloneResourceEntry(v));
            }
            if (m.templates) {
                for (const [k, v] of Object.entries(m.templates)) this._templates.set(k, McpGrammar._cloneTemplateEntry(v));
            }
            if (m.phrases) {
                for (const [k, v] of Object.entries(m.phrases)) if (typeof v === "string") this._phrases.set(k, v);
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
            (typeof d.server === "object" && d.server !== null) ||
            (typeof d.tools === "object" && d.tools !== null) ||
            (typeof d.resources === "object" && d.resources !== null) ||
            (typeof d.templates === "object" && d.templates !== null) ||
            (typeof d.phrases === "object" && d.phrases !== null)
        );
    }

    // ── Phrases ──────────────────────────────────────────────────────────────

    /** The phrase under a key, its holes unfilled; `undefined` when the grammar has none. */
    getPhrase(key: string): string | undefined {
        return this._phrases.get(key);
    }

    setPhrase(key: string, template: string): void {
        this._phrases.set(key, template);
    }

    /** The keys of every phrase this grammar carries, in insertion order. */
    listPhrases(): string[] {
        return [...this._phrases.keys()];
    }

    /** True when the grammar carries at least one phrase. */
    hasPhrases(): boolean {
        return this._phrases.size > 0;
    }

    /** The phrases as plain data, for a resource or a file. */
    getPhrases(): McpGrammarPhrases {
        return Object.fromEntries(this._phrases);
    }

    /**
     * A phrase filled with `values`. A key the grammar lacks comes back as
     * the key itself, so a missing sentence is seen where it should have
     * been read; a hole with no value reads `?`, never an invented value.
     */
    phrase(key: string, values: Record<string, unknown> = {}): string {
        const template = this._phrases.get(key);
        return template === undefined ? key : fillPhrase(template, values);
    }

    /**
     * How `other`'s phrases differ from this grammar's, taken as the
     * reference wording: a key this grammar has that `other` lacks, a key
     * `other` has that this grammar lacks, a phrase whose holes differ. Two
     * locale files of one server should differ in nothing here.
     */
    comparePhrases(other: McpGrammar, options: { subset?: boolean } = {}): McpGrammarProblem[] {
        const problems: McpGrammarProblem[] = [];
        for (const [key, template] of this._phrases) {
            const theirs = other._phrases.get(key);
            if (theirs === undefined) {
                if (!options.subset) problems.push({ kind: "phrase", name: key, message: `phrase "${key}" is missing` });
                continue;
            }
            const mine = phraseHoles(template).join(",");
            const holes = phraseHoles(theirs).join(",");
            if (mine !== holes) problems.push({ kind: "phrase", name: key, message: `phrase "${key}" names the holes {${holes}} where the reference names {${mine}}` });
        }
        for (const key of other._phrases.keys())
            if (!this._phrases.has(key)) problems.push({ kind: "phrase", name: key, message: `phrase "${key}" is not in the reference wording` });
        return problems;
    }

    // ── Server words ─────────────────────────────────────────────────────────

    /** The one-line description of the server in this wording, if the grammar carries one. */
    getServerDescription(): string | undefined {
        return this._server.description;
    }

    setServerDescription(description: string): void {
        this._server.description = description;
    }

    /** The usage note a session receives in `initialize.instructions`, in this wording, if the grammar carries one. */
    getServerInstructions(): string | undefined {
        return this._server.instructions;
    }

    setServerInstructions(instructions: string): void {
        this._server.instructions = instructions;
    }

    // ── Check against a surface ──────────────────────────────────────────────

    /**
     * What this grammar names that the given surface does not have: a tool,
     * a property (dotted for nested objects and array items, as
     * `properties` keys are written), a resource URI, a template. A grammar
     * with no problem describes only things that exist; the server applies
     * it without surprise.
     */
    check(surface: {
        tools?: ReadonlyArray<{ name: string; inputSchema?: unknown }>;
        resources?: ReadonlyArray<{ uri: string }>;
        templates?: ReadonlyArray<{ uriTemplate: string }>;
        /** The phrase keys the host reads; a phrase under another key is a problem. */
        phrases?: ReadonlyArray<string>;
    }): McpGrammarProblem[] {
        const problems: McpGrammarProblem[] = [];
        if (surface.phrases) {
            const keys = new Set(surface.phrases);
            for (const key of this._phrases.keys()) if (!keys.has(key)) problems.push({ kind: "phrase", name: key, message: `phrase "${key}" is not one the host reads` });
        }
        const tools = new Map((surface.tools ?? []).map((t) => [t.name, t]));
        for (const [name, entry] of this._tools) {
            const tool = tools.get(name);
            if (!tool) {
                problems.push({ kind: "tool", name, message: `tool "${name}" does not exist on this surface` });
                continue;
            }
            const paths = new Set(McpGrammar._schemaPaths(tool.inputSchema));
            for (const prop of Object.keys(entry.properties ?? {})) {
                if (!paths.has(prop))
                    problems.push({
                        kind: "property",
                        name: `${name}.${prop}`,
                        message: `tool "${name}" has no property "${prop}" (properties: ${[...paths].join(", ") || "none"})`,
                    });
            }
        }
        if (surface.resources) {
            const uris = new Set(surface.resources.map((r) => r.uri));
            for (const uri of this._resources.keys())
                if (!uris.has(uri)) problems.push({ kind: "resource", name: uri, message: `resource "${uri}" does not exist on this surface` });
        }
        if (surface.templates) {
            const uris = new Set(surface.templates.map((t) => t.uriTemplate));
            for (const uri of this._templates.keys())
                if (!uris.has(uri)) problems.push({ kind: "template", name: uri, message: `template "${uri}" does not exist on this surface` });
        }
        return problems;
    }

    /** The property names a schema declares, dotted for nested objects and array items. */
    private static _schemaPaths(schema: unknown, prefix = ""): string[] {
        const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
        if (!props) return [];
        const out: string[] = [];
        for (const [name, sub] of Object.entries(props)) {
            out.push(`${prefix}${name}`);
            out.push(...McpGrammar._schemaPaths(sub, `${prefix}${name}.`));
            const items = (sub as { items?: unknown } | undefined)?.items;
            if (items) out.push(...McpGrammar._schemaPaths(items, `${prefix}${name}.`));
        }
        return out;
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

        if (this._server.description !== undefined || this._server.instructions !== undefined) out.server = { ...this._server };
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
        if (this._phrases.size > 0) out.phrases = Object.fromEntries(this._phrases);

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
     * entries from earlier grammars, only explicit strings override.
     */
    static merge(...grammars: (McpGrammar | undefined)[]): McpGrammar {
        const result = new McpGrammar();
        for (const g of grammars) {
            if (!g) continue;

            // Server words
            if (g._server.description !== undefined) result._server.description = g._server.description;
            if (g._server.instructions !== undefined) result._server.instructions = g._server.instructions;

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

            // Phrases: a later wording replaces a sentence, never erases one.
            for (const [key, template] of g._phrases) result._phrases.set(key, template);
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
