/**
 * The words of a server live in its grammar (2026-09-21): the `server`
 * section (description, instructions), the check of a grammar against the
 * surface it describes, the directory loader that composes families over a
 * baseline, the wording rule of the builder, and the initialize result that
 * carries the server's words and the matched key.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpGrammar } from "../src/mcp.grammar";
import { McpBehaviorBase } from "../src/mcp.behaviorBase";
import { McpToolResults } from "../src/mcp.toolResult";
import { McpServerBuilder } from "../src/server/mcp.server.builder";
import { LoopbackTransport } from "../src/server/loopback.transport";
import { loadGrammarDirectory } from "../src/node/grammar.directory";
import type { McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult } from "../src/interfaces";

/** A behavior that declares structure only: its words are in a grammar. */
class Wordless extends McpBehaviorBase {
    constructor() {
        super({ domain: "test", namespace: "ws", name: "ws", description: "" });
    }
    override getTools(): McpTool[] {
        return [{ name: "list", description: "", inputSchema: { type: "object", properties: { taskId: { type: "string" }, path: { type: "string" } } } }];
    }
    override getResources(): McpResource[] {
        return [{ uri: "ws://writes", name: "ws://writes", description: "", mimeType: "application/json" }];
    }
    override getResourceTemplates(): McpResourceTemplate[] {
        return [];
    }
    override async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        return { uri, mimeType: "application/json", text: "[]" };
    }
    override async executeToolAsync(): Promise<McpToolResult> {
        return McpToolResults.json({});
    }
}

const EN = { server: { description: "A task's own files", instructions: "Every path is relative to the task." }, tools: { list: { title: "List", description: "The files of a task.", properties: { taskId: "the task", path: "a folder" } } }, resources: { "ws://writes": { name: "Writes", description: "Every write." } } };
const FR = { server: { description: "Les fichiers d'une tâche", instructions: "Tout chemin est relatif à la tâche." }, tools: { list: { title: "Lister", description: "Les fichiers d'une tâche." } } };
const CLAUDE_EN = { tools: { list: { description: "The files of a task, with their sha256." } } };

describe("the server's words in a grammar", () => {
    it("carries a server section, merges it, and serialises it", () => {
        const g = McpGrammar.fromJSON(EN);
        expect(g.getServerDescription()).toBe("A task's own files");
        expect(g.getServerInstructions()).toBe("Every path is relative to the task.");
        const merged = McpGrammar.merge(g, McpGrammar.fromJSON({ server: { instructions: "Overlaid." } }));
        expect(merged.getServerDescription()).toBe("A task's own files");
        expect(merged.getServerInstructions()).toBe("Overlaid.");
        expect(merged.toJSON().server).toEqual({ description: "A task's own files", instructions: "Overlaid." });
    });

    it("checks itself against a surface: unknown tools, properties and resources are problems", () => {
        const bad = McpGrammar.fromJSON({ tools: { list: { properties: { ghost: "x" } }, nope: { description: "y" } }, resources: { "ws://none": { description: "z" } } });
        const problems = bad.check({ tools: new Wordless().getTools(), resources: new Wordless().getResources() });
        expect(problems.map((p) => p.name).sort()).toEqual(["list.ghost", "nope", "ws://none"]);
        expect(McpGrammar.fromJSON(EN).check({ tools: new Wordless().getTools(), resources: new Wordless().getResources() })).toEqual([]);
    });

    it("loads a directory: families overlaid on the baseline of their locale, files with sha256, problems named", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "grammars-"));
        try {
            for (const [agent, locale, data] of [["default", "en", EN], ["default", "fr", FR], ["claude", "en", CLAUDE_EN]] as const) {
                mkdirSync(path.join(dir, agent), { recursive: true });
                writeFileSync(path.join(dir, agent, `${locale}.json`), JSON.stringify(data));
            }
            const loaded = loadGrammarDirectory(dir, { surface: { tools: new Wordless().getTools(), resources: new Wordless().getResources() } });
            expect([...loaded.grammars.keys()].sort()).toEqual(["claude:en", "default:en", "default:fr"]);
            const claude = loaded.grammars.get("claude:en")!;
            expect(claude.getToolDescription("list")).toBe("The files of a task, with their sha256.");
            expect(claude.getToolTitle("list")).toBe("List"); // from the baseline
            expect(claude.getServerInstructions()).toBe("Every path is relative to the task.");
            expect(loaded.files.map((f) => f.key)).toEqual(["claude:en", "default:en", "default:fr"]);
            expect(loaded.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);

            writeFileSync(path.join(dir, "claude", "en.json"), JSON.stringify({ tools: { nope: { description: "x" } } }));
            expect(() => loadGrammarDirectory(dir, { surface: { tools: new Wordless().getTools() } })).toThrow(/nope/);
            expect(loadGrammarDirectory(dir, { surface: { tools: new Wordless().getTools() }, tolerate: true }).problems.length).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the builder's wording rule: one place, never none, never both", () => {
        const wordless = () => new McpServerBuilder().withName("ws").withTransport(new LoopbackTransport()).register(new Wordless()).withWordingRule("default:en");
        expect(() => wordless().build()).toThrow(/tool "list" has no description/);
        expect(() => wordless().withGrammar("default:en", McpGrammar.fromJSON(EN)).build()).not.toThrow();
        class Worded extends Wordless {
            override getTools(): McpTool[] {
                return [{ ...super.getTools()[0], description: "inline" }];
            }
        }
        expect(() => new McpServerBuilder().withName("ws").withTransport(new LoopbackTransport()).register(new Worded()).withGrammar("default:en", McpGrammar.fromJSON(EN)).withWordingRule("default:en").build()).toThrow(/both inline and in grammar/);
    });

    it("initialize carries the grammar's server words and the matched key", () => {
        const server = new McpServerBuilder()
            .withName("ws")
            .withTransport(new LoopbackTransport())
            .register(new Wordless())
            .withGrammars(new Map([["default:en", McpGrammar.fromJSON(EN)], ["default:fr", McpGrammar.fromJSON(FR)]]))
            .withGrammarResolver((_client, caps) => ((caps as { locale?: string })?.locale === "fr" ? ["default:fr", "default:en"] : ["default:en"]))
            .withWordingRule("default:en")
            .build();
        const en = server.initialize({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: {} } });
        const enResult = (en as { result: { serverInfo: { description?: string }; instructions?: string; _meta?: { grammar?: string } } }).result;
        expect(enResult.serverInfo.description).toBe("A task's own files");
        expect(enResult.instructions).toBe("Every path is relative to the task.");
        expect(enResult._meta?.grammar).toBe("default:en");
        const fr = server.initialize({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: { locale: "fr" } } });
        const frResult = (fr as { result: { instructions?: string; _meta?: { grammar?: string } } }).result;
        expect(frResult.instructions).toBe("Tout chemin est relatif à la tâche.");
        expect(frResult._meta?.grammar).toBe("default:fr");
        const tools = (server.toolsList({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) as { result: { tools: McpTool[] } }).result.tools;
        expect(tools[0].description).toBe("Les fichiers d'une tâche.");
    });
});
