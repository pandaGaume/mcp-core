import type { McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "./interfaces";
import { JsonRpcMimeType } from "./interfaces";
import { McpBehaviorBase, McpBehaviorOptions } from "./mcp.behaviorBase";
import type { McpGrammarData } from "./mcp.grammar";
import { McpGrammar } from "./mcp.grammar";
import { McpGrammarStore } from "./mcp.grammarStore";
import { McpToolResults } from "./mcp.toolResult";

/**
 * MCP behavior that exposes grammar profile management as first-class tools.
 *
 * Extends {@link McpBehaviorBase} directly: no 3D adapter is needed because
 * grammar profiles are pure data, not engine objects.
 *
 * The behavior reads from and writes to a shared {@link McpGrammarStore}.
 * When a profile is created or updated the store emits a change event that
 * the {@link McpServer} listens to, re-merging the session grammar and sending
 * `notifications/tools/list_changed` so connected clients see fresh descriptions.
 *
 * @example
 * ```typescript
 * const store = new McpGrammarStore();
 * const grammar = new McpGrammarBehavior(store);
 *
 * const server = new McpServerBuilder()
 *     .withName("factory-floor")
 *     .withTransport(transport)
 *     .withGrammarStore(store)
 *     .withGrammarResolver(() => "welding-robot-3A")
 *     .register(meshBehavior, grammar)
 *     .build();
 * ```
 */
export class McpGrammarBehavior extends McpBehaviorBase {
    // ── Tool name constants ──────────���──────────────────────────────────────

    public static readonly GrammarListFn = "grammar_list";
    public static readonly GrammarReadFn = "grammar_read";
    public static readonly GrammarSetFn = "grammar_set";
    public static readonly GrammarDeleteFn = "grammar_delete";
    public static readonly GrammarImportFn = "grammar_import";
    public static readonly GrammarExportFn = "grammar_export";

    private readonly _store: McpGrammarStore;

    public constructor(store: McpGrammarStore, options: McpBehaviorOptions = {}) {
        super({
            ...options,
            domain: options.domain ?? "mcp",
            namespace: options.namespace ?? "grammar",
        });
        this._store = store;
    }

    // ── Design-time (schema) ────────────────────────────────────────────────

    public override getTools(): McpTool[] {
        return [
            {
                name: McpGrammarBehavior.GrammarListFn,
                description:
                    "Lists every grammar profile currently registered in the store. " +
                    "Each profile tailors how tools and their parameters are described " +
                    "for a specific device, process, or audience, enabling an LLM to " +
                    "reason about the same capability in domain-specific terms.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },
            {
                name: McpGrammarBehavior.GrammarReadFn,
                description:
                    "Returns the full grammar profile for a given profile ID: every " +
                    "tool-level and property-level description override that shapes how " +
                    "an LLM perceives the device's capabilities.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                        profileId: {
                            type: "string",
                            description: "Profile identifier to read (e.g. 'welding-robot-3A').",
                        },
                    },
                    required: ["uri", "profileId"],
                    additionalProperties: false,
                },
            },
            {
                name: McpGrammarBehavior.GrammarSetFn,
                description:
                    "Creates or replaces a grammar profile. The data object maps tool " +
                    "names to description overrides: { toolName: { description?, " +
                    "properties?: { propName: description } } }. Supports dot-notation " +
                    "for nested properties (e.g. 'patch.position'). After saving, every " +
                    "connected session bound to this profile receives a " +
                    "tools/list_changed notification and sees updated tool descriptions " +
                    "on the next tools/list call.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                        profileId: {
                            type: "string",
                            description: "Profile identifier to create or replace.",
                        },
                        data: {
                            type: "object",
                            description: "Grammar data keyed by tool name. Each value is " + "{ description?: string, properties?: Record<string, string> }.",
                            additionalProperties: {
                                type: "object",
                                properties: {
                                    description: {
                                        type: "string",
                                        description: "Override for the tool-level description.",
                                    },
                                    properties: {
                                        type: "object",
                                        description: "Map of property names to description overrides. " + "Supports dot-notation for nested properties.",
                                        additionalProperties: { type: "string" },
                                    },
                                },
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["uri", "profileId", "data"],
                    additionalProperties: false,
                },
            },
            {
                name: McpGrammarBehavior.GrammarDeleteFn,
                description:
                    "Removes a grammar profile by ID. Sessions bound to this profile " + "revert to baseline tool descriptions and receive a " + "tools/list_changed notification.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                        profileId: {
                            type: "string",
                            description: "Profile identifier to delete.",
                        },
                    },
                    required: ["uri", "profileId"],
                    additionalProperties: false,
                },
            },
            {
                name: McpGrammarBehavior.GrammarImportFn,
                description:
                    "Bulk-imports grammar profiles from a single JSON object. Each key " +
                    "is a profile ID and each value is grammar data. Existing profiles " +
                    "with the same ID are replaced. Useful for restoring a previously " +
                    "exported configuration or deploying a fleet of device grammars.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                        profiles: {
                            type: "object",
                            description: "Map of profile IDs to grammar data objects.",
                            additionalProperties: {
                                type: "object",
                                additionalProperties: {
                                    type: "object",
                                    properties: {
                                        description: { type: "string" },
                                        properties: {
                                            type: "object",
                                            additionalProperties: { type: "string" },
                                        },
                                    },
                                    additionalProperties: false,
                                },
                            },
                        },
                    },
                    required: ["uri", "profiles"],
                    additionalProperties: false,
                },
            },
            {
                name: McpGrammarBehavior.GrammarExportFn,
                description:
                    "Exports every grammar profile as a single JSON snapshot. The " +
                    "result can be saved to a file and later re-imported with " +
                    "grammar_import to restore the full grammar configuration.",
                inputSchema: {
                    type: "object",
                    properties: {
                        uri: {
                            type: "string",
                            description: "Grammar namespace URI (mcp://grammar).",
                        },
                    },
                    required: ["uri"],
                    additionalProperties: false,
                },
            },
        ];
    }

    public override getResources(): McpResource[] {
        return [
            {
                uri: this.baseUri,
                name: "Grammar profiles",
                description: "All grammar profiles currently registered in the store.",
                mimeType: JsonRpcMimeType,
            },
        ];
    }

    public override getResourceTemplates(): McpResourceTemplate[] {
        return [
            {
                uriTemplate: `${this.baseUri}/{profileId}`,
                name: "Grammar profile",
                description: "A single grammar profile identified by its profile ID.",
                mimeType: JsonRpcMimeType,
            },
        ];
    }

    // ── Runtime ─────���───────────────────────────────────────────────────────

    public override async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        // Root resource: list all profile IDs
        if (uri === this.baseUri) {
            return {
                uri,
                mimeType: JsonRpcMimeType,
                text: JSON.stringify({ profiles: this._store.list() }),
            };
        }

        // Template match: mcp://grammar/{profileId}
        const prefix = `${this.baseUri}/`;
        if (uri.startsWith(prefix)) {
            const profileId = uri.substring(prefix.length);
            const grammar = this._store.get(profileId);
            if (!grammar) return undefined;
            return {
                uri,
                mimeType: JsonRpcMimeType,
                text: JSON.stringify(grammar.toJSON()),
            };
        }

        return undefined;
    }

    public override async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        switch (toolName) {
            case McpGrammarBehavior.GrammarListFn:
                return McpToolResults.json({ profiles: this._store.list() });

            case McpGrammarBehavior.GrammarReadFn: {
                const profileId = args["profileId"] as string | undefined;
                if (!profileId) return McpToolResults.error("Missing required argument: profileId");
                const grammar = this._store.get(profileId);
                if (!grammar) return McpToolResults.error(`Grammar profile not found: "${profileId}"`);
                return McpToolResults.json(grammar.toJSON());
            }

            case McpGrammarBehavior.GrammarSetFn: {
                const profileId = args["profileId"] as string | undefined;
                const data = args["data"] as McpGrammarData | undefined;
                if (!profileId) return McpToolResults.error("Missing required argument: profileId");
                if (!data) return McpToolResults.error("Missing required argument: data");
                this._store.set(profileId, McpGrammar.fromJSON(data));
                return McpToolResults.text(`Grammar profile "${profileId}" saved.`);
            }

            case McpGrammarBehavior.GrammarDeleteFn: {
                const profileId = args["profileId"] as string | undefined;
                if (!profileId) return McpToolResults.error("Missing required argument: profileId");
                if (!this._store.delete(profileId)) return McpToolResults.error(`Grammar profile not found: "${profileId}"`);
                return McpToolResults.text(`Grammar profile "${profileId}" deleted.`);
            }

            case McpGrammarBehavior.GrammarImportFn: {
                const profiles = args["profiles"] as Record<string, McpGrammarData> | undefined;
                if (!profiles) return McpToolResults.error("Missing required argument: profiles");
                this._store.importAll(profiles);
                return McpToolResults.text(`Imported ${Object.keys(profiles).length} grammar profile(s).`);
            }

            case McpGrammarBehavior.GrammarExportFn:
                return McpToolResults.json(this._store.exportAll());

            default:
                return McpToolResults.error(`Unknown tool: "${toolName}"`);
        }
    }
}
