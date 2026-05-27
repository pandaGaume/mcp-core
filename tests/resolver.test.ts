import { describe, it, expect } from "vitest";
import { grammarResolverFromOptions } from "../src/mcp.resolver";
import type { GrammarResolverOptions } from "../src/mcp.resolver";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function withDefaults(extra: Partial<GrammarResolverOptions> & Pick<GrammarResolverOptions, "localeSource">): GrammarResolverOptions {
    return extra;
}

function call(opts: GrammarResolverOptions, clientName: string, capabilities?: Record<string, unknown>): readonly string[] {
    const resolver = grammarResolverFromOptions(opts);
    const out = resolver({ name: clientName, version: "0.0.0" }, capabilities as never);
    if (out === undefined) return [];
    return typeof out === "string" ? [out] : out;
}

// ---------------------------------------------------------------------------
// Agent matching
// ---------------------------------------------------------------------------

describe("grammarResolverFromOptions — agent matching", () => {
    const opts = withDefaults({ localeSource: () => "en" });

    it("matches claude clients via substring", () => {
        const chain = call(opts, "Claude-Desktop");
        expect(chain).toContain("claude:en");
    });

    it("matches gpt clients via openai alias", () => {
        const chain = call(opts, "openai-assistant");
        expect(chain).toContain("gpt:en");
    });

    it("falls back to default agent for unknown clients", () => {
        const chain = call(opts, "MysteryClient");
        expect(chain[0]).toBe("default:en");
    });

    it("respects a custom agents map", () => {
        const chain = call(
            withDefaults({
                localeSource: () => "en",
                agents: { robot: ["robot", "bot"] },
            }),
            "my-bot-v3"
        );
        expect(chain[0]).toBe("robot:en");
    });

    it("collapses every client to default when agents is empty", () => {
        const chain = call(withDefaults({ localeSource: () => "en", agents: {} }), "Claude");
        expect(chain[0]).toBe("default:en");
    });
});

// ---------------------------------------------------------------------------
// Locale narrowing
// ---------------------------------------------------------------------------

describe("grammarResolverFromOptions — locale narrowing", () => {
    it("emits region then bare language then en fallback", () => {
        const chain = call({ localeSource: () => "fr-CA" }, "Claude");
        // Most-specific first, then progressively dropped.
        expect(chain[0]).toBe("claude:fr-ca");
        expect(chain).toContain("claude:fr");
        // The fallbackKey default kicks in last.
        expect(chain[chain.length - 1]).toBe("default:en");
    });

    it("does not emit a region segment when none was supplied", () => {
        const chain = call({ localeSource: () => "zh" }, "Claude");
        expect(chain).toContain("claude:zh");
        expect(chain.find((k) => k.includes("zh-"))).toBeUndefined();
    });

    it("normalizes the raw locale to lowercase", () => {
        const chain = call({ localeSource: () => "EN-US" }, "Claude");
        expect(chain[0]).toBe("claude:en-us");
        expect(chain).toContain("claude:en");
    });

    it("drops the locale dimension entirely when localeSource returns undefined", () => {
        const chain = call({ localeSource: () => undefined }, "Claude");
        // No locale at all → key is agent-only.
        expect(chain).toContain("claude");
        expect(chain).toContain("default");
    });
});

// ---------------------------------------------------------------------------
// Version dimension (opt-in)
// ---------------------------------------------------------------------------

describe("grammarResolverFromOptions — versioning (opt-in)", () => {
    it("never includes a @version segment when versionFrom is absent", () => {
        const chain = call({ localeSource: () => "fr" }, "Claude");
        expect(chain.every((k) => !k.includes("@"))).toBe(true);
    });

    it("appends @version when versionFrom returns a value", () => {
        const chain = call(
            {
                localeSource: () => "fr",
                versionFrom: () => "v2",
            },
            "Claude"
        );
        expect(chain[0]).toBe("claude:fr@v2");
        // The narrowing chain must include the version-dropped variant
        // so a behavior shipping "claude:fr" still matches.
        expect(chain).toContain("claude:fr");
    });

    it("skips the version dimension when versionFrom returns undefined", () => {
        const chain = call(
            {
                localeSource: () => "fr",
                versionFrom: () => undefined,
            },
            "Claude"
        );
        expect(chain.every((k) => !k.includes("@"))).toBe(true);
    });

    it("threads capabilities through to versionFrom", () => {
        const chain = call(
            {
                localeSource: () => "fr",
                versionFrom: (_, caps) => (caps as { protocolVersion?: string } | undefined)?.protocolVersion,
            },
            "Claude",
            { protocolVersion: "2025-06-18" }
        );
        expect(chain[0]).toBe("claude:fr@2025-06-18");
    });
});

// ---------------------------------------------------------------------------
// composeKey customization + dedup
// ---------------------------------------------------------------------------

describe("grammarResolverFromOptions — composeKey + dedup", () => {
    it("uses a custom composeKey when provided", () => {
        const chain = call(
            {
                localeSource: () => "en",
                versionFrom: () => "v1",
                composeKey: ({ agent, locale, version }) => `${agent}/${locale ?? "*"}/${version ?? "*"}`,
            },
            "Claude"
        );
        expect(chain[0]).toBe("claude/en/v1");
    });

    it("strips duplicate keys produced by narrowing collapses", () => {
        // When the locale is just "en" (no region), dropping the region
        // axis yields the same key as not dropping it. The dedup pass
        // must collapse these into a single entry.
        const chain = call({ localeSource: () => "en" }, "Claude");
        const set = new Set(chain);
        expect(chain.length).toBe(set.size);
    });

    it("appends the configured fallbackKey at the end", () => {
        const chain = call(
            {
                localeSource: () => "fr",
                fallbackKey: "ROOT",
            },
            "Claude"
        );
        expect(chain[chain.length - 1]).toBe("ROOT");
    });

    it("omits the fallback entirely when fallbackKey is empty string", () => {
        const chain = call(
            {
                localeSource: () => "fr",
                fallbackKey: "",
            },
            "Claude"
        );
        expect(chain.find((k) => k === "default:en")).toBeUndefined();
    });
});
