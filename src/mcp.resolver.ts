import type { McpClientCapabilities, McpClientInfo } from "./interfaces/mcp.core.interfaces";
import type { McpGrammarResolver } from "./interfaces/mcp.server.interfaces";

/**
 * Built-in resolver helper that turns a declarative
 * {@link GrammarResolverOptions} into an {@link McpGrammarResolver}
 * producing a most-specific-first fallback chain.
 *
 * The helper composes a grammar key from up to three dimensions:
 *
 *   - **agent**   matched on `clientInfo.name` against
 *                  {@link GrammarResolverOptions.agents} (e.g. `claude`,
 *                  `gpt`, ...). Unknown clients fall through to `default`.
 *   - **locale**  supplied by the application via
 *                  {@link GrammarResolverOptions.localeSource} (no default;
 *                  the host knows where its locale lives).
 *   - **version** opt-in via {@link GrammarResolverOptions.versionFrom}.
 *                  When unset the version dimension is dropped entirely.
 *
 * The fallback chain is produced by progressively dropping dimensions in
 * the order configured by {@link GrammarResolverOptions.narrowing} (default
 * `["version", "locale-region", "locale", "agent"]`). The final
 * {@link GrammarResolverOptions.fallbackKey} is appended last so the
 * server always has a last-resort candidate.
 *
 * The {@link McpServer} consumes the chain by trying each candidate in
 * order and selecting the first that yields a non-empty merged grammar
 * (any of behavior / adapter / static / store layers matching).
 */

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Dimensions the helper may drop from a grammar key while building the
 * fallback chain. The order in
 * {@link GrammarResolverOptions.narrowing} controls which dimension is
 * tried first; earlier entries are dropped earlier.
 *
 *   - `version`         drops the version suffix (`@v2`)
 *   - `locale-region`   drops the region of a BCP-47 locale
 *                        (e.g. `fr-CA` → `fr`)
 *   - `locale`          drops the language entirely
 *   - `agent`           replaces the agent family with `default`
 */
export type NarrowDimension = "version" | "locale-region" | "locale" | "agent";

/**
 * Source for the raw locale string at session time. Returns `undefined`
 * when the host cannot determine a locale; the helper then bypasses the
 * locale dimension altogether (chain becomes agent + version only).
 */
export type LocaleSource = (clientInfo: McpClientInfo, capabilities?: McpClientCapabilities) => string | undefined;

/**
 * Source for the protocol / API version dimension. Returns `undefined`
 * to skip the version dimension for this session.
 */
export type VersionSource = (clientInfo: McpClientInfo, capabilities?: McpClientCapabilities) => string | undefined;

/**
 * Composes a grammar key string from the three resolved dimensions.
 * Default: `<agent>:<locale>` when `version` is absent,
 *          `<agent>:<locale>@<version>` when `version` is present.
 *
 * When `locale` is absent (the host has no locale), the default falls
 * back to `<agent>` alone, or `<agent>@<version>` when versioned.
 */
export type ComposeKey = (parts: { agent: string; locale?: string; version?: string }) => string;

/**
 * Declarative options consumed by {@link grammarResolverFromOptions}.
 *
 * `localeSource` is the only required field: there is no sensible default
 * for "where does the locale live in your stack" (env var? client field?
 * negotiated capability?). The application must decide explicitly.
 *
 * `versionFrom` is opt-in: omit it and the version dimension is never
 * baked into the chain. Most apps will not need it.
 */
export interface GrammarResolverOptions {
    /**
     * Map of agent family identifier → substring patterns matched against
     * `clientInfo.name` (case-insensitive). First family with a matching
     * substring wins. Clients matching none fall through to `default`.
     *
     * Default: `{ claude: ["claude"], gpt: ["gpt", "openai"],
     *             mistral: ["mistral"], copilot: ["copilot"] }`
     *
     * Pass `{}` to disable agent recognition entirely (every client
     * resolves to `default`).
     */
    agents?: Record<string, readonly string[]>;

    /**
     * REQUIRED. Returns the raw locale string for the current session.
     * Typical implementations:
     * ```ts
     * (clientInfo) => clientInfo.locale
     * (_, capabilities) => capabilities?.locale
     * () => process.env.MCP_LOCALE
     * ```
     * Return `undefined` to skip the locale dimension entirely for the
     * session (chain becomes agent + version only).
     */
    localeSource: LocaleSource;

    /**
     * Optional. When present and returning a non-empty value, the version
     * dimension is appended to the composed key. Omit to never include
     * a version segment.
     */
    versionFrom?: VersionSource;

    /**
     * Customizes how the three resolved dimensions are assembled into a
     * single key string. Defaults to `<agent>:<locale>` or
     * `<agent>:<locale>@<version>`.
     */
    composeKey?: ComposeKey;

    /**
     * Ordered list of dimensions to drop while building the fallback
     * chain (most-aggressive-narrowing first).
     *
     * Default: `["version", "locale-region", "locale", "agent"]`.
     *
     * With the default order, a client resolved to
     * `claude / fr-CA / v2` produces:
     *   1. `claude:fr-CA@v2` (full)
     *   2. `claude:fr-CA`    (drop version)
     *   3. `claude:fr@v2`    (drop region)
     *   4. `claude:fr`       (drop region + version)
     *   5. `default:fr-CA@v2`(drop agent)
     *   6. ...
     *
     * The combinatorics fan out automatically; the order parameter just
     * controls which axis is sacrificed first when there is a conflict.
     */
    narrowing?: readonly NarrowDimension[];

    /**
     * Last-resort candidate appended to every chain. Default `"default:en"`.
     * Pass `""` to disable the trailing fallback (the server will then
     * skip grammar patching when no other candidate matches a layer).
     */
    fallbackKey?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_AGENTS: Record<string, readonly string[]> = {
    claude: ["claude"],
    gpt: ["gpt", "openai"],
    mistral: ["mistral"],
    copilot: ["copilot"],
};

const DEFAULT_NARROWING: readonly NarrowDimension[] = ["version", "locale-region", "locale", "agent"];

const DEFAULT_FALLBACK_KEY = "default:en";

const DEFAULT_COMPOSE_KEY: ComposeKey = ({ agent, locale, version }) => {
    let key = locale ? `${agent}:${locale}` : agent;
    if (version) key = `${key}@${version}`;
    return key;
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Substring match `clientInfo.name` against the configured agents map. */
function resolveAgent(clientInfo: McpClientInfo, agents: Record<string, readonly string[]>): string {
    const name = (clientInfo.name ?? "").toLowerCase();
    for (const [family, patterns] of Object.entries(agents)) {
        for (const p of patterns) {
            if (p && name.includes(p.toLowerCase())) return family;
        }
    }
    return "default";
}

/** Lowercase the raw locale and split into language + region halves. */
function splitLocale(raw: string | undefined): { language?: string; region?: string } {
    if (!raw) return {};
    const lc = raw.toLowerCase();
    const dash = lc.indexOf("-");
    if (dash < 0) return { language: lc };
    return { language: lc.slice(0, dash), region: lc.slice(dash + 1) };
}

/**
 * Yields every combination of (agent, locale, version) reachable by
 * progressively dropping dimensions in `narrowing` order. Duplicates are
 * filtered downstream by the dedup pass.
 *
 * Implemented as a nested loop rather than a recursion to keep the
 * fallback chain length bounded and predictable.
 */
function* enumerateCandidates(
    base: { agent: string; language?: string; region?: string; version?: string },
    narrowing: readonly NarrowDimension[],
    composeKey: ComposeKey
): Generator<string> {
    // We treat the four dimensions as bitmask switches; for each candidate
    // step in `narrowing` we mask out the matching axis on subsequent
    // emissions. The cap is at 2^4 - duplicates -> at most ~12 distinct
    // keys, which fits the human-readable expectations of the doc.
    const dropVersion: boolean[] = narrowing.includes("version") ? [false, true] : [false];
    const dropRegion: boolean[] = narrowing.includes("locale-region") ? [false, true] : [false];
    const dropLocale: boolean[] = narrowing.includes("locale") ? [false, true] : [false];
    const dropAgent: boolean[] = narrowing.includes("agent") ? [false, true] : [false];

    // Permutation order matters for emission priority. Walk the dropX
    // axes following the user-supplied `narrowing` order.
    const order = narrowing.slice();
    const isFirst = (d: NarrowDimension) => order.indexOf(d);

    // Sort flags so that earlier-dropped dimensions iterate slower (outer
    // loop), producing the most-specific-first chain.
    const dvFlags = dropVersion;
    const drFlags = dropRegion;
    const dlFlags = dropLocale;
    const daFlags = dropAgent;

    // Compute axis priority. Inner-most axis = LAST in `order`.
    // We sort axes by their position in order, ascending: smaller index = outer loop.
    const axes: Array<{ name: NarrowDimension; flags: boolean[] }> = [
        { name: "version" as const, flags: dvFlags },
        { name: "locale-region" as const, flags: drFlags },
        { name: "locale" as const, flags: dlFlags },
        { name: "agent" as const, flags: daFlags },
    ];
    axes.sort((a, b) => {
        const ia = isFirst(a.name);
        const ib = isFirst(b.name);
        // Dimensions not in the narrowing list go to the end (their flag
        // is just [false] so they collapse to a single iteration anyway).
        return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    });

    const [a0, a1, a2, a3] = axes;
    for (const f0 of a0.flags) {
        for (const f1 of a1.flags) {
            for (const f2 of a2.flags) {
                for (const f3 of a3.flags) {
                    const flagOf = (name: NarrowDimension): boolean => {
                        if (a0.name === name) return f0;
                        if (a1.name === name) return f1;
                        if (a2.name === name) return f2;
                        if (a3.name === name) return f3;
                        return false;
                    };

                    const useVersion = !flagOf("version") ? base.version : undefined;
                    const useRegion = !flagOf("locale-region") ? base.region : undefined;
                    const useLanguage = !flagOf("locale") ? base.language : undefined;
                    const useAgent = !flagOf("agent") ? base.agent : "default";

                    // Locale is "language" or "language-region" when present.
                    let locale: string | undefined;
                    if (useLanguage) {
                        locale = useRegion ? `${useLanguage}-${useRegion}` : useLanguage;
                    }

                    yield composeKey({ agent: useAgent, locale, version: useVersion });
                }
            }
        }
    }
}

/** De-duplicate while preserving first-occurrence order. */
function dedup(items: Iterable<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of items) {
        if (x && !seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    return out;
}

// ─── Public factory ──────────────────────────────────────────────────────────

/**
 * Builds an {@link McpGrammarResolver} from a declarative
 * {@link GrammarResolverOptions}. Used internally by
 * `McpServerBuilder.withGrammarResolver(options)`; exposed for advanced
 * cases where you want to wrap or compose the chain (e.g. inject a
 * monitoring layer, prepend hard-coded keys).
 *
 * The returned resolver is stateless; calling it multiple times for the
 * same client returns the same chain.
 */
export function grammarResolverFromOptions(options: GrammarResolverOptions): McpGrammarResolver {
    const agents = options.agents ?? DEFAULT_AGENTS;
    const composeKey = options.composeKey ?? DEFAULT_COMPOSE_KEY;
    const narrowing = options.narrowing ?? DEFAULT_NARROWING;
    const fallbackKey = options.fallbackKey ?? DEFAULT_FALLBACK_KEY;
    const localeSource = options.localeSource;
    const versionFrom = options.versionFrom;

    return (clientInfo, capabilities) => {
        const agent = resolveAgent(clientInfo, agents);
        const rawLocale = localeSource(clientInfo, capabilities);
        const { language, region } = splitLocale(rawLocale);
        const version = versionFrom?.(clientInfo, capabilities) || undefined;

        const candidates: string[] = [];
        for (const key of enumerateCandidates({ agent, language, region, version }, narrowing, composeKey)) {
            candidates.push(key);
        }
        if (fallbackKey) candidates.push(fallbackKey);

        const chain = dedup(candidates);
        return chain.length === 0 ? undefined : chain;
    };
}
