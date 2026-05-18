/**
 * Serialisable grammar layer that holds tool-level and property-level descriptions,
 * editable at runtime and round-tripped to/from JSON.
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

// ── Serialisation shape ──────────────────────────────────────────────────────

/** Describes one tool inside a serialised grammar. */
export type McpGrammarToolEntry = {
    /** Tool-level description (what the tool does). */
    description?: string;
    /** Per-property descriptions keyed by property name (supports dot-notation, e.g. "patch.position"). */
    properties?: Record<string, string>;
};

/** Plain JSON-safe object that can be persisted / transmitted. */
export type McpGrammarData = Record<string, McpGrammarToolEntry>;

// ── Grammar class ────────────────────────────────────────────────────────────

export class McpGrammar {
    private _entries = new Map<string, McpGrammarToolEntry>();

    // ── Construction ─────────────────────────────────────────────────────────

    constructor(data?: McpGrammarData) {
        if (data) {
            for (const [toolName, entry] of Object.entries(data)) {
                this._entries.set(toolName, McpGrammar._cloneEntry(entry));
            }
        }
    }

    // ── Tool description ─────────────────────────────────────────────────────

    getToolDescription(toolName: string): string | undefined {
        return this._entries.get(toolName)?.description;
    }

    setToolDescription(toolName: string, description: string): void {
        const entry = this._ensureEntry(toolName);
        entry.description = description;
    }

    // ── Property description ─────────────────────────────────────────────────

    getPropertyDescription(toolName: string, propertyName: string): string | undefined {
        return this._entries.get(toolName)?.properties?.[propertyName];
    }

    setPropertyDescription(toolName: string, propertyName: string, description: string): void {
        const entry = this._ensureEntry(toolName);
        if (!entry.properties) {
            entry.properties = {};
        }
        entry.properties[propertyName] = description;
    }

    // ── Serialisation ────────────────────────────────────────────────────────

    /** Returns a plain JSON-safe snapshot of this grammar. */
    toJSON(): McpGrammarData {
        const out: McpGrammarData = {};
        for (const [toolName, entry] of this._entries) {
            out[toolName] = McpGrammar._cloneEntry(entry);
        }
        return out;
    }

    /** Constructs a grammar from a plain JSON object. */
    static fromJSON(data: McpGrammarData): McpGrammar {
        return new McpGrammar(data);
    }

    // ── Merge ────────────────────────────────────────────────────────────────

    /**
     * Creates a new grammar by overlaying entries from left to right.
     * Later grammars win.  `undefined` entries in a later grammar do NOT
     * erase entries from earlier grammars — only explicit strings override.
     */
    static merge(...grammars: (McpGrammar | undefined)[]): McpGrammar {
        const result = new McpGrammar();
        for (const g of grammars) {
            if (!g) continue;
            for (const [toolName, src] of g._entries) {
                const dest = result._ensureEntry(toolName);
                if (src.description !== undefined) {
                    dest.description = src.description;
                }
                if (src.properties) {
                    if (!dest.properties) {
                        dest.properties = {};
                    }
                    for (const [prop, desc] of Object.entries(src.properties)) {
                        dest.properties[prop] = desc;
                    }
                }
            }
        }
        return result;
    }

    // ── Clone ────────────────────────────────────────────────────────────────

    clone(): McpGrammar {
        return new McpGrammar(this.toJSON());
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private _ensureEntry(toolName: string): McpGrammarToolEntry {
        let entry = this._entries.get(toolName);
        if (!entry) {
            entry = {};
            this._entries.set(toolName, entry);
        }
        return entry;
    }

    private static _cloneEntry(entry: McpGrammarToolEntry): McpGrammarToolEntry {
        const clone: McpGrammarToolEntry = {};
        if (entry.description !== undefined) {
            clone.description = entry.description;
        }
        if (entry.properties) {
            clone.properties = { ...entry.properties };
        }
        return clone;
    }
}
