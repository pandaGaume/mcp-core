/**
 * Grammars from a directory of files, one per audience and language:
 *
 *     <dir>/default/en.json        the baseline in English
 *     <dir>/default/fr.json        the baseline in French
 *     <dir>/claude/en.json         what changes for the claude family, in English
 *     <dir>/nemotron/en.json       ...
 *
 * Each file is a {@link McpGrammarData} (`server`, `tools`, `resources`,
 * `templates`). The loader composes one grammar per `<agent>:<locale>` key:
 * the family's file laid over the `default` file of the same locale, so a
 * family file says only what differs. `default:<locale>` keys are kept as
 * they are. Every grammar is checked against the surface it will describe
 * (tools, resources, templates): a name the surface does not have is a
 * problem, listed with its file, and `loadGrammarDirectory` throws unless
 * told to keep going. With a `referenceLocale`, the phrases of every
 * `default/<locale>` file must match that locale's (same keys, same holes),
 * and a family file may only reword phrases the reference has; a directory
 * whose files carry no phrase is not asked for a reference file.
 *
 * Node only (it reads the file system): `@cyanmycelium/mcp-core/node`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { McpGrammar, type McpGrammarData, type McpGrammarProblem } from "../mcp.grammar";

export interface GrammarDirectorySurface {
    tools?: ReadonlyArray<{ name: string; inputSchema?: unknown }>;
    resources?: ReadonlyArray<{ uri: string }>;
    templates?: ReadonlyArray<{ uriTemplate: string }>;
}

export interface GrammarDirectoryOptions {
    /** The surface the grammars describe; a name they use that it lacks is a problem. Without it, nothing is checked. */
    surface?: GrammarDirectorySurface;
    /** The folder whose files are the baseline the family files overlay. Default `default`. */
    baseline?: string;
    /** Return the problems instead of throwing on them. Default false. */
    tolerate?: boolean;
    /** The locale whose phrases every other file must match: same keys and holes for the baseline's locales, a subset for a family's. None checked without it. */
    referenceLocale?: string;
}

export interface GrammarDirectoryFile {
    /** `<agent>:<locale>` */
    key: string;
    file: string;
    sha256: string;
    problems: McpGrammarProblem[];
}

export interface GrammarDirectory {
    /** Composed grammars by `<agent>:<locale>` key, families overlaid on the baseline of their locale. */
    grammars: Map<string, McpGrammar>;
    /** The files read, with their sha256, in key order. */
    files: GrammarDirectoryFile[];
    /** The problems of every file, `"<file>: <message>"`. */
    problems: string[];
}

/** Reads and composes the grammars of a directory. Missing directory: empty result. */
export function loadGrammarDirectory(dir: string, options: GrammarDirectoryOptions = {}): GrammarDirectory {
    const baseline = options.baseline ?? "default";
    const raw = new Map<string, { agent: string; locale: string; grammar: McpGrammar }>();
    const files: GrammarDirectoryFile[] = [];
    const problems: string[] = [];
    if (existsSync(dir) && statSync(dir).isDirectory()) {
        for (const agent of readdirSync(dir).sort()) {
            const agentDir = path.join(dir, agent);
            if (!statSync(agentDir).isDirectory()) continue;
            for (const entry of readdirSync(agentDir).sort()) {
                if (!entry.endsWith(".json")) continue;
                const file = path.join(agentDir, entry);
                const locale = entry.slice(0, -".json".length).toLowerCase();
                const key = `${agent.toLowerCase()}:${locale}`;
                const text = readFileSync(file, "utf8");
                let data: McpGrammarData;
                try {
                    data = JSON.parse(text) as McpGrammarData;
                } catch (e) {
                    problems.push(`${file}: ${(e as Error).message}`);
                    continue;
                }
                const grammar = McpGrammar.fromJSON(data);
                const own = options.surface ? grammar.check(options.surface) : [];
                for (const p of own) problems.push(`${file}: ${p.message}`);
                raw.set(key, { agent: agent.toLowerCase(), locale, grammar });
                files.push({ key, file, sha256: createHash("sha256").update(text).digest("hex"), problems: own });
            }
        }
    }
    // A directory whose files carry no phrase has nothing to compare: the reference is required only once a file has some.
    if (options.referenceLocale && [...raw.values()].some((r) => r.grammar.hasPhrases())) {
        const reference = raw.get(`${baseline}:${options.referenceLocale.toLowerCase()}`)?.grammar;
        if (!reference) problems.push(`${dir}: no ${baseline}/${options.referenceLocale}.json to take the phrases from`);
        else
            for (const [key, { agent, grammar }] of raw) {
                if (key === `${baseline}:${options.referenceLocale.toLowerCase()}`) continue;
                const file = files.find((f) => f.key === key);
                const own = reference.comparePhrases(grammar, { subset: agent !== baseline });
                for (const p of own) problems.push(`${file?.file ?? key}: ${p.message}`);
                if (file) file.problems.push(...own);
            }
    }
    const grammars = new Map<string, McpGrammar>();
    for (const [key, { agent, locale, grammar }] of raw) {
        const base = agent === baseline ? undefined : raw.get(`${baseline}:${locale}`)?.grammar;
        grammars.set(key, base ? McpGrammar.merge(base, grammar) : grammar);
    }
    if (problems.length && !options.tolerate) throw new Error(`grammar directory ${dir}: ${problems.join("; ")}`);
    return { grammars, files, problems };
}
