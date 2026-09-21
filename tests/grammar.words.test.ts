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
import { GRAMMAR_PHRASES_URI, McpGrammar, fillPhrase, phraseHoles } from "../src/mcp.grammar";
import { McpBehaviorBase } from "../src/mcp.behaviorBase";
import { McpToolResults } from "../src/mcp.toolResult";
import { McpServerBuilder } from "../src/server/mcp.server.builder";
import { McpServer } from "../src/server/mcp.server";
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

const EN = {
    server: { description: "A task's own files", instructions: "Every path is relative to the task." },
    tools: { list: { title: "List", description: "The files of a task.", properties: { taskId: "the task", path: "a folder" } } },
    resources: { "ws://writes": { name: "Writes", description: "Every write." } },
};
const FR = {
    server: { description: "Les fichiers d'une tâche", instructions: "Tout chemin est relatif à la tâche." },
    tools: { list: { title: "Lister", description: "Les fichiers d'une tâche." } },
};
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
            for (const [agent, locale, data] of [
                ["default", "en", EN],
                ["default", "fr", FR],
                ["claude", "en", CLAUDE_EN],
            ] as const) {
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
        const wordless = () => new McpServerBuilder().withName("ws").withTransport(LoopbackTransport.createPair()[0]).register(new Wordless()).withWordingRule("default:en");
        expect(() => wordless().build()).toThrow(/tool "list" has no description/);
        expect(() => wordless().withGrammar("default:en", McpGrammar.fromJSON(EN)).build()).not.toThrow();
        class Worded extends Wordless {
            override getTools(): McpTool[] {
                return [{ ...super.getTools()[0], description: "inline" }];
            }
        }
        expect(() =>
            new McpServerBuilder()
                .withName("ws")
                .withTransport(LoopbackTransport.createPair()[0])
                .register(new Worded())
                .withGrammar("default:en", McpGrammar.fromJSON(EN))
                .withWordingRule("default:en")
                .build()
        ).toThrow(/both inline and in grammar/);
    });

    it("initialize carries the grammar's server words and the matched key", () => {
        const server = new McpServerBuilder()
            .withName("ws")
            .withTransport(LoopbackTransport.createPair()[0])
            .register(new Wordless())
            .withGrammars(
                new Map([
                    ["default:en", McpGrammar.fromJSON(EN)],
                    ["default:fr", McpGrammar.fromJSON(FR)],
                ])
            )
            .withGrammarResolver((_client, caps) => ((caps as { locale?: string })?.locale === "fr" ? ["default:fr", "default:en"] : ["default:en"]))
            .withWordingRule("default:en")
            .build() as McpServer;
        const en = server.initialize({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: {} },
        });
        const enResult = (en as { result: { serverInfo: { description?: string }; instructions?: string; _meta?: { grammar?: string } } }).result;
        expect(enResult.serverInfo.description).toBe("A task's own files");
        expect(enResult.instructions).toBe("Every path is relative to the task.");
        expect(enResult._meta?.grammar).toBe("default:en");
        const fr = server.initialize({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: { locale: "fr" } },
        });
        const frResult = (fr as { result: { instructions?: string; _meta?: { grammar?: string } } }).result;
        expect(frResult.instructions).toBe("Tout chemin est relatif à la tâche.");
        expect(frResult._meta?.grammar).toBe("default:fr");
        const tools = (server.toolsList({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) as { result: { tools: McpTool[] } }).result.tools;
        expect(tools[0].description).toBe("Les fichiers d'une tâche.");
    });
});

/**
 * The phrases (2026-09-21, 1.2.0): free sentences a host says or shows,
 * keyed, with holes; the same keys and holes in every locale of a server;
 * the session's phrases served as `grammar://phrases`.
 */
describe("the phrases of a wording", () => {
    const EN_PHRASES = { ...EN, phrases: { "step.fit": "Model fitted on {rows} rows, rmse {rmse}.", "end.proposed": "Proposed to the station: {proposalId}." } };
    const FR_PHRASES = { ...FR, phrases: { "step.fit": "Modèle ajusté sur {rows} lignes, rmse {rmse}.", "end.proposed": "Proposé à la station : {proposalId}." } };

    it("carries phrases, fills their holes, merges and serialises them", () => {
        const g = McpGrammar.fromJSON(EN_PHRASES);
        expect(g.listPhrases()).toEqual(["step.fit", "end.proposed"]);
        expect(g.phrase("step.fit", { rows: 19, rmse: 0.0008 })).toBe("Model fitted on 19 rows, rmse 0.0008.");
        expect(g.phrase("step.fit", { rows: 19 })).toBe("Model fitted on 19 rows, rmse ?.");
        expect(g.phrase("no.such.key", { rows: 1 })).toBe("no.such.key");
        expect(phraseHoles("{b} and {a} and {b}")).toEqual(["a", "b"]);
        expect(fillPhrase("{x}-{y}", { x: 1 })).toBe("1-?");
        const merged = McpGrammar.merge(g, McpGrammar.fromJSON({ phrases: { "step.fit": "Fitted on {rows} rows ({rmse})." } }));
        expect(merged.phrase("step.fit", { rows: 2, rmse: 0 })).toBe("Fitted on 2 rows (0).");
        expect(merged.phrase("end.proposed", { proposalId: "p1" })).toBe("Proposed to the station: p1.");
        expect(merged.toJSON().phrases).toEqual({ "step.fit": "Fitted on {rows} rows ({rmse}).", "end.proposed": "Proposed to the station: {proposalId}." });
        expect(McpGrammar.fromJSON({ phrases: { a: "x" } }).hasPhrases()).toBe(true);
        expect(McpGrammar.fromJSON(EN).hasPhrases()).toBe(false);
    });

    it("compares the phrases of two wordings: same keys, same holes; a family may reword a subset", () => {
        const en = McpGrammar.fromJSON(EN_PHRASES);
        expect(en.comparePhrases(McpGrammar.fromJSON(FR_PHRASES))).toEqual([]);
        const bad = McpGrammar.fromJSON({ phrases: { "step.fit": "Ajusté sur {lignes} lignes.", "end.other": "Autre." } });
        expect(
            bad
                ? en
                      .comparePhrases(bad)
                      .map((p) => p.name)
                      .sort()
                : []
        ).toEqual(["end.other", "end.proposed", "step.fit"]);
        expect(en.comparePhrases(McpGrammar.fromJSON({ phrases: { "step.fit": "Fitted on {rows} rows, {rmse}." } }), { subset: true })).toEqual([]);
        expect(en.check({ tools: new Wordless().getTools(), phrases: ["step.fit"] }).map((p) => p.name)).toEqual(["end.proposed"]);
    });

    it("a directory's locales must carry the reference locale's phrases", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "phrases-"));
        try {
            for (const [agent, locale, data] of [
                ["default", "en", EN_PHRASES],
                ["default", "fr", { ...FR_PHRASES, phrases: { ...FR_PHRASES.phrases, "step.fit": "Modèle ajusté sur {lignes} lignes." } }],
                ["claude", "en", { phrases: { "end.proposed": "Handed to the station: {proposalId}." } }],
            ] as const) {
                mkdirSync(path.join(dir, agent), { recursive: true });
                writeFileSync(path.join(dir, agent, `${locale}.json`), JSON.stringify(data));
            }
            const loaded = loadGrammarDirectory(dir, { referenceLocale: "en", tolerate: true });
            expect(loaded.problems.length).toBe(1);
            expect(loaded.problems[0]).toMatch(/fr\.json.*step\.fit.*\{lignes\}.*\{rmse,rows\}/);
            expect(loaded.grammars.get("claude:en")!.phrase("end.proposed", { proposalId: "p2" })).toBe("Handed to the station: p2.");
            expect(loaded.grammars.get("claude:en")!.phrase("step.fit", { rows: 3, rmse: 0 })).toBe("Model fitted on 3 rows, rmse 0.");
            expect(() => loadGrammarDirectory(dir, { referenceLocale: "en" })).toThrow(/step\.fit/);
            expect(loadGrammarDirectory(dir, { referenceLocale: "de", tolerate: true }).problems[0]).toMatch(/no default\/de\.json/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the server serves the session's phrases as grammar://phrases, in the wording it resolved", async () => {
        const server = new McpServerBuilder()
            .withName("ws")
            .withTransport(LoopbackTransport.createPair()[0])
            .register(new Wordless())
            .withGrammars(
                new Map([
                    ["default:en", McpGrammar.fromJSON(EN_PHRASES)],
                    ["default:fr", McpGrammar.fromJSON(FR_PHRASES)],
                    ["default:de", McpGrammar.fromJSON(EN)],
                ])
            )
            .withGrammarResolver((_client, caps) => [`default:${(caps as { locale?: string })?.locale ?? "en"}`, "default:en"])
            .withWordingRule("default:en")
            .build() as McpServer;
        const init = (id: number, locale?: string) =>
            server.initialize({
                jsonrpc: "2.0",
                id,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: locale ? { locale } : {} },
            });
        init(1, "fr");
        const listed = (
            server.resourcesList({ jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }) as { result: { resources: Array<{ uri: string }> } }
        ).result.resources.map((r) => r.uri);
        expect(listed).toContain(GRAMMAR_PHRASES_URI);
        const read = (await server.resourcesRead({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: GRAMMAR_PHRASES_URI } })) as {
            result: { contents: Array<{ text: string }> };
        };
        const body = JSON.parse(read.result.contents[0].text) as { grammar: string; phrases: Record<string, string> };
        expect(body.grammar).toBe("default:fr");
        expect(McpGrammar.fromJSON({ phrases: body.phrases }).phrase("end.proposed", { proposalId: "p3" })).toBe("Proposé à la station : p3.");
        init(4, "de");
        const none = (
            server.resourcesList({ jsonrpc: "2.0", id: 5, method: "resources/list", params: {} }) as { result: { resources: Array<{ uri: string }> } }
        ).result.resources.map((r) => r.uri);
        expect(none).not.toContain(GRAMMAR_PHRASES_URI);
        const missing = (await server.resourcesRead({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: GRAMMAR_PHRASES_URI } })) as { error?: { code: number } };
        expect(missing.error?.code).toBe(-32002);
    });
});
