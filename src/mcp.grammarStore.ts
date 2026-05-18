import { McpGrammar, McpGrammarData } from "./mcp.grammar";
import { createEventEmitter, IEventEmitter, IEventSource } from "./interfaces/eventSource";

// ── Change event ────────────────────────────────────────────────────────────

/** Describes a mutation in the grammar store. */
export interface McpGrammarStoreChangeEvent {
    /** The profile that was affected. */
    profileId: string;
    /** Whether the profile was created/updated or deleted. */
    type: "set" | "delete";
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * Mutable, observable registry of named {@link McpGrammar} profiles.
 *
 * The store is the single source of truth for runtime grammar data.
 * Both the {@link McpServer} and the {@link McpGrammarBehavior} hold a
 * reference to the same store instance:
 *
 * - The **behavior** writes profiles via MCP tool calls (grammar_set, grammar_delete, …).
 * - The **server** reads profiles during `initialize` and subscribes to
 *   {@link onChanged} so it can re-merge the session grammar and emit
 *   `notifications/tools/list_changed` when a profile is updated.
 *
 * Profiles are cloned on read and write to prevent external mutation from
 * bypassing the event system.
 */
export class McpGrammarStore {
    private readonly _profiles = new Map<string, McpGrammar>();
    private readonly _onChanged: IEventEmitter<McpGrammarStoreChangeEvent> = createEventEmitter<McpGrammarStoreChangeEvent>();

    // ── Read ────────────────────────────────────────────────────────────────

    /** Subscribable event source — fires after every `set`, `delete`, `importAll`, or `clear`. */
    get onChanged(): IEventSource<McpGrammarStoreChangeEvent> {
        return this._onChanged;
    }

    /** Returns `true` if a profile with the given ID exists in the store. */
    has(profileId: string): boolean {
        return this._profiles.has(profileId);
    }

    /** Returns a clone of the profile, or `undefined` if not found. */
    get(profileId: string): McpGrammar | undefined {
        return this._profiles.get(profileId)?.clone();
    }

    /** Returns all profile IDs currently in the store. */
    list(): string[] {
        return Array.from(this._profiles.keys());
    }

    // ── Write ───────────────────────────────────────────────────────────────

    /** Creates or replaces a profile. The grammar is cloned before storage. */
    set(profileId: string, grammar: McpGrammar): void {
        this._profiles.set(profileId, grammar.clone());
        this._onChanged.emit({ profileId, type: "set" });
    }

    /** Removes a profile. Returns `false` if the profile did not exist. */
    delete(profileId: string): boolean {
        if (!this._profiles.delete(profileId)) return false;
        this._onChanged.emit({ profileId, type: "delete" });
        return true;
    }

    // ── Bulk ────────────────────────────────────────────────────────────────

    /**
     * Replaces or adds multiple profiles from a plain JSON object.
     * Each key is a profile ID, each value is serialised grammar data.
     * Emits one change event per profile.
     */
    importAll(data: Record<string, McpGrammarData>): void {
        for (const [id, grammarData] of Object.entries(data)) {
            this._profiles.set(id, McpGrammar.fromJSON(grammarData));
            this._onChanged.emit({ profileId: id, type: "set" });
        }
    }

    /** Returns a JSON-safe snapshot of every profile in the store. */
    exportAll(): Record<string, McpGrammarData> {
        const out: Record<string, McpGrammarData> = {};
        for (const [id, grammar] of this._profiles) {
            out[id] = grammar.toJSON();
        }
        return out;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /** Removes all profiles. Emits a delete event for each. */
    clear(): void {
        for (const id of Array.from(this._profiles.keys())) {
            this._profiles.delete(id);
            this._onChanged.emit({ profileId: id, type: "delete" });
        }
    }

    /** Removes all profiles and clears all event subscriptions. */
    dispose(): void {
        this._profiles.clear();
        this._onChanged.clear();
    }
}
