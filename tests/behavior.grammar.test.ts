import { describe, it, expect } from "vitest";
import { McpAdapterBase, McpBehavior, McpGrammar, McpGrammarStore, McpServer } from "../src";
import type { McpResource, McpResourceContent, McpResourceTemplate, McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from "../src/interfaces";

// ---------------------------------------------------------------------------
// Minimal adapter + behavior fixtures
// ---------------------------------------------------------------------------

/**
 * Stub adapter that declares no resources, no tools — just enough surface
 * for `McpBehavior` to instantiate. Optionally ships an adapter-side
 * grammar override for a specific key.
 */
class StubAdapter extends McpAdapterBase {
    private readonly _adapterGrammar?: McpGrammar;
    private readonly _adapterKey?: string;

    constructor(domain: string, opts?: { adapterKey: string; grammar: McpGrammar }) {
        super(domain);
        if (opts) {
            this._adapterKey = opts.adapterKey;
            this._adapterGrammar = opts.grammar;
        }
    }

    public async readResourceAsync(_uri: string): Promise<McpResourceContent | undefined> {
        return undefined;
    }
    public async executeToolAsync(_uri: string, _toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
        return { content: [] };
    }

    public override getGrammar(key: string): McpGrammar | undefined {
        return this._adapterKey && key === this._adapterKey ? this._adapterGrammar : undefined;
    }
}

/**
 * Test behavior with a single "ping" tool whose inline description is the
 * English fallback, plus a configurable grammar map declaring overrides
 * for one or more keys.
 */
class TestBehavior extends McpBehavior {
    private readonly _grammars: Map<string, McpGrammar>;

    constructor(adapter: StubAdapter, grammars: Map<string, McpGrammar> = new Map()) {
        super(adapter, { domain: "test", namespace: "ping" });
        this._grammars = grammars;
    }

    protected override _buildGrammars(): Map<string, McpGrammar> {
        return new Map(this._grammars);
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "ping",
                description: "Inline EN baseline",
                inputSchema: {
                    type: "object",
                    properties: {
                        msg: { type: "string", description: "Inline EN msg description" },
                    },
                    additionalProperties: false,
                },
            },
        ];
    }

    protected override _buildResources(): McpResource[] {
        return [];
    }
    protected override _buildTemplate(): McpResourceTemplate[] {
        return [];
    }

    public mutateGrammars(next: Map<string, McpGrammar>): void {
        this._grammars.clear();
        for (const [k, v] of next) this._grammars.set(k, v);
        this._invalidateGrammars();
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(opts: {
    behavior: TestBehavior;
    staticGrammars?: Map<string, McpGrammar>;
    store?: McpGrammarStore;
    resolver?: ReturnType<typeof makeChainResolver>;
}): McpServer {
    const server = new McpServer("test-server", {}, undefined, undefined, opts.staticGrammars, opts.resolver, undefined, opts.store);
    server.register(opts.behavior);
    return server;
}

function makeChainResolver(chain: readonly string[]): (clientInfo: { name: string; version: string }) => readonly string[] {
    return () => chain;
}

function initRequest(): JsonRpcRequest {
    return {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test-client", version: "0.0.0" } },
    };
}

function toolsListRequest(): JsonRpcRequest {
    return { jsonrpc: "2.0", id: 2, method: "tools/list" };
}

function pingDescription(resp: JsonRpcResponse): string | undefined {
    const tools = (resp.result as { tools: McpTool[] }).tools;
    return tools.find((t) => t.name === "ping")?.description;
}

function msgDescription(resp: JsonRpcResponse): string | undefined {
    const tools = (resp.result as { tools: McpTool[] }).tools;
    const schema = tools.find((t) => t.name === "ping")?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
    return schema?.properties?.["msg"]?.description;
}

// ---------------------------------------------------------------------------
// Behavior-owned grammar
// ---------------------------------------------------------------------------

describe("Behavior-owned grammar layer", () => {
    it("listGrammarKeys() reports every declared key", () => {
        const b = new TestBehavior(
            new StubAdapter("test"),
            new Map([
                ["default:en", new McpGrammar()],
                ["default:fr", new McpGrammar()],
                ["claude:fr", new McpGrammar()],
            ])
        );
        expect(b.listGrammarKeys().slice().sort()).toEqual(["claude:fr", "default:en", "default:fr"]);
    });

    it("getGrammar() returns the matching entry or undefined", () => {
        const en = McpGrammar.fromJSON({ tools: { ping: { description: "EN baseline" } } });
        const b = new TestBehavior(new StubAdapter("test"), new Map([["default:en", en]]));
        expect(b.getGrammar("default:en")).toBe(en);
        expect(b.getGrammar("default:fr")).toBeUndefined();
    });

    it("default _buildGrammars() returns an empty map (backwards compat)", () => {
        class NoGrammarBehavior extends McpBehavior {
            constructor() {
                super(new StubAdapter("d"), { domain: "d", namespace: "n" });
            }
            protected override _buildTools(): McpTool[] {
                return [];
            }
        }
        const b = new NoGrammarBehavior();
        expect(b.listGrammarKeys()).toEqual([]);
        expect(b.getGrammar("anything")).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Four-layer merge end-to-end
// ---------------------------------------------------------------------------

describe("McpServer.initialize — four-layer grammar merge", () => {
    it("picks the behavior's grammar when no other layer matches", () => {
        const fr = McpGrammar.fromJSON({
            tools: { ping: { description: "FR baseline", properties: { msg: "FR msg" } } },
        });
        const behavior = new TestBehavior(new StubAdapter("test"), new Map([["default:fr", fr]]));
        const server = makeServer({ behavior, resolver: makeChainResolver(["default:fr"]) });

        server.initialize(initRequest());
        const list = server.toolsList(toolsListRequest());
        expect(pingDescription(list)).toBe("FR baseline");
        expect(msgDescription(list)).toBe("FR msg");
    });

    it("adapter layer overrides behavior layer for the same key", () => {
        const behaviorFr = McpGrammar.fromJSON({ tools: { ping: { description: "behavior FR" } } });
        const adapterFr = McpGrammar.fromJSON({ tools: { ping: { description: "adapter FR" } } });
        const adapter = new StubAdapter("test", { adapterKey: "default:fr", grammar: adapterFr });
        const behavior = new TestBehavior(adapter, new Map([["default:fr", behaviorFr]]));
        const server = makeServer({ behavior, resolver: makeChainResolver(["default:fr"]) });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("adapter FR");
    });

    it("static withGrammar() overrides behavior + adapter for the same key", () => {
        const behaviorFr = McpGrammar.fromJSON({ tools: { ping: { description: "behavior FR" } } });
        const adapterFr = McpGrammar.fromJSON({ tools: { ping: { description: "adapter FR" } } });
        const staticFr = McpGrammar.fromJSON({ tools: { ping: { description: "static FR" } } });
        const adapter = new StubAdapter("test", { adapterKey: "default:fr", grammar: adapterFr });
        const behavior = new TestBehavior(adapter, new Map([["default:fr", behaviorFr]]));
        const server = makeServer({
            behavior,
            staticGrammars: new Map([["default:fr", staticFr]]),
            resolver: makeChainResolver(["default:fr"]),
        });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("static FR");
    });

    it("store layer wins over every other layer (highest priority)", () => {
        const behaviorFr = McpGrammar.fromJSON({ tools: { ping: { description: "behavior FR" } } });
        const staticFr = McpGrammar.fromJSON({ tools: { ping: { description: "static FR" } } });
        const storeFr = McpGrammar.fromJSON({ tools: { ping: { description: "store FR" } } });
        const behavior = new TestBehavior(new StubAdapter("test"), new Map([["default:fr", behaviorFr]]));
        const store = new McpGrammarStore();
        store.set("default:fr", storeFr);
        const server = makeServer({
            behavior,
            staticGrammars: new Map([["default:fr", staticFr]]),
            store,
            resolver: makeChainResolver(["default:fr"]),
        });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("store FR");
    });

    it("falls back to inline EN baseline when no layer matches the chain", () => {
        const behavior = new TestBehavior(new StubAdapter("test"));
        const server = makeServer({ behavior, resolver: makeChainResolver(["zz"]) });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("Inline EN baseline");
    });
});

// ---------------------------------------------------------------------------
// Candidate chain selection
// ---------------------------------------------------------------------------

describe("McpServer.initialize — candidate chain selection", () => {
    it("picks the first candidate that has at least one layer registered", () => {
        const fr = McpGrammar.fromJSON({ tools: { ping: { description: "behavior FR" } } });
        const behavior = new TestBehavior(new StubAdapter("test"), new Map([["default:fr", fr]]));
        const server = makeServer({
            behavior,
            // The resolver asks for fr-CA first but only fr exists.
            resolver: makeChainResolver(["default:fr-ca", "default:fr", "default:en"]),
        });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("behavior FR");
    });

    it("returns inline baselines when every candidate in the chain misses", () => {
        const behavior = new TestBehavior(new StubAdapter("test"));
        const server = makeServer({ behavior, resolver: makeChainResolver(["a", "b", "c"]) });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("Inline EN baseline");
    });

    it("accepts a single string as a length-1 chain (backwards compat)", () => {
        const fr = McpGrammar.fromJSON({ tools: { ping: { description: "behavior FR" } } });
        const behavior = new TestBehavior(new StubAdapter("test"), new Map([["default:fr", fr]]));
        const legacyResolver = () => "default:fr";
        const server = makeServer({ behavior, resolver: legacyResolver as never });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("behavior FR");
    });
});

// ---------------------------------------------------------------------------
// Hot-reload via onGrammarsChanged
// ---------------------------------------------------------------------------

describe("McpServer — behavior onGrammarsChanged", () => {
    it("re-merges the session grammar when the behavior invalidates", () => {
        const fr = McpGrammar.fromJSON({ tools: { ping: { description: "v1" } } });
        const behavior = new TestBehavior(new StubAdapter("test"), new Map([["default:fr", fr]]));
        const server = makeServer({ behavior, resolver: makeChainResolver(["default:fr"]) });

        server.initialize(initRequest());
        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("v1");

        // Hot-reload the behavior's grammars with a new payload.
        behavior.mutateGrammars(new Map([["default:fr", McpGrammar.fromJSON({ tools: { ping: { description: "v2" } } })]]));

        expect(pingDescription(server.toolsList(toolsListRequest()))).toBe("v2");
    });
});
