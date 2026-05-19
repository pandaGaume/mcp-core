[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-core)](https://www.npmjs.com/package/@cyanmycelium/mcp-core)
[![CI](https://github.com/pandaGaume/mcp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pandaGaume/mcp-core/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @cyanmycelium/mcp-core

Engine-neutral primitives for building [Model Context Protocol](https://modelcontextprotocol.io/) servers and clients in TypeScript.

> Status: pre-release (v0.0.0). Public API ships in v0.1.0.

---

## Why this package

The official MCP TypeScript SDK gives you JSON-RPC plumbing and a way to register tools and resources. That is enough for a script that exposes a handful of functions. It is not enough when:

- you need **multiple LLM clients** to see different tool descriptions on the same server (Claude wants concise, an internal tool prefers verbose);
- the **set of live resources changes** while sessions are open (objects added, renamed, removed) and the agent must be notified;
- the **same tool catalog** must run against different backends (a 3D engine, a geo viewer, a node graph, a test mock);
- a tool may exist conceptually but is **not supported on this particular instance** (e.g. orbit on a fixed camera), and you want the client to never see it instead of getting an error;
- you want **agents to rewrite their own tool descriptions mid-session** and persist that across reconnects.

`@cyanmycelium/mcp-core` is the abstraction stack that makes those concerns first-class instead of bolt-ons. It is engine-neutral, runtime-agnostic, and has been used in production behind a multi-backend MCP server.

## The four-layer stack

```
   ┌──────────────────────────────────────────────────────┐
   │  GRAMMAR    composable description overrides,        │
   │             resolved per session, mutable at runtime │
   └──────────────────────────────────────────────────────┘
                              ▲ applied to
   ┌──────────────────────────────────────────────────────┐
   │  BEHAVIOR   identity, namespace, tool/resource       │
   │             schemas (the MCP-side contract)          │
   └──────────────────────────────────────────────────────┘
                              ▲ delegates runtime ops to
   ┌──────────────────────────────────────────────────────┐
   │  ADAPTER    runtime, executes against the actual     │
   │             host objects, emits change events        │
   └──────────────────────────────────────────────────────┘
                              ▲ produces / consumes
   ┌──────────────────────────────────────────────────────┐
   │  STATE      serializable, read-only snapshots of     │
   │             those objects (resource contents)        │
   └──────────────────────────────────────────────────────┘
```

Each layer is independently testable. Each layer can be swapped without touching the others.

| Layer | You write | Reused across |
|---|---|---|
| Behavior | Schemas of tools/resources, namespace, URI template | All hosts |
| Adapter | Live binding to a backend (3D scene, graph, DB, API) | One backend at a time |
| State | TypeScript interfaces describing resource contents | All hosts |
| Grammar | JSON files of description overrides | All hosts, selected per client |

## What you get over a flat `{tool, schema, handler}` setup

| Capability | Flat MCP | This package |
|---|---|---|
| Per-session tool descriptions | no | `McpGrammarResolver(clientInfo) -> key` |
| Runtime mutation of descriptions | no | `McpGrammarStore` + `McpGrammarBehavior` |
| Hide tools per instance type | manual error in handler | `getToolSupport(toolName, resourceType?)` returns `None`/`Partial`/`Full` |
| RFC 6570 URI templates with fallback matching | no | static index + template regex match |
| Live resource change notifications | manual | `adapter.onResourcesChanged`, `onResourceContentChanged` |
| Same tools across multiple backends | duplicate per backend | one Behavior, swap the Adapter |
| Tree-shakeable browser/Node split | one bundle | subpath exports (`.`, `./server`, `./client`, `./llm`, `./node`) |

## Install

```sh
npm install @cyanmycelium/mcp-core
```

## Runtimes

Runs in both Node.js and the browser. In Node the typical transport is stdio (`StdioTransport`). In the browser the server lives next to the app and connects to an MCP broker over WebSocket (`DirectTransport`, `MultiplexTransport`); the broker relays JSON-RPC frames to and from the actual MCP client.

## Subpath entry points

```ts
import { McpBehavior, McpAdapterBase, McpGrammar, McpToolResults } from "@cyanmycelium/mcp-core";
import { McpServer, McpServerBuilder, LoopbackTransport }          from "@cyanmycelium/mcp-core/server";
import { McpClient }                                               from "@cyanmycelium/mcp-core/client";
import { LlmClient }                                               from "@cyanmycelium/mcp-core/llm";
import { StdioTransport }                                          from "@cyanmycelium/mcp-core/node"; // Node-only
```

Tree-shaking ensures browser bundles never pull `node:*` modules.

## Quick start: a minimal MCP server

A behavior owns the **schemas**, an adapter owns the **execution**. The server wires them together with a transport.

```ts
import {
    McpAdapterBase,
    McpBehavior,
    McpBehaviorOptions,
    McpResource,
    McpResourceContent,
    McpTool,
    McpToolResult,
    McpToolResults,
} from "@cyanmycelium/mcp-core";
import { McpServerBuilder } from "@cyanmycelium/mcp-core/server";
import { StdioTransport }   from "@cyanmycelium/mcp-core/node";

// 1. State: read-only snapshot of the resource (here a single counter).
interface CounterState {
    value: number;
}

// 2. Adapter: executes against the real object.
class CounterAdapter extends McpAdapterBase {
    public static readonly URI = "app://counter";
    private _value = 0;

    constructor() {
        super("app");
    }

    public async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri !== CounterAdapter.URI) return undefined;
        const state: CounterState = { value: this._value };
        return { uri, mimeType: "application/json", text: JSON.stringify(state) };
    }

    public async executeToolAsync(
        _uri: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<McpToolResult> {
        switch (toolName) {
            case "counter_increment":
                this._value += (args.by as number | undefined) ?? 1;
                this._forwardResourceContentChanged(CounterAdapter.URI);
                return McpToolResults.json({ value: this._value });

            case "counter_reset":
                this._value = 0;
                this._forwardResourceContentChanged(CounterAdapter.URI);
                return McpToolResults.text("counter reset");

            default:
                return McpToolResults.error(`unknown tool: ${toolName}`);
        }
    }
}

// 3. Behavior: declares what the world sees. No execution code here.
class CounterBehavior extends McpBehavior {
    public static readonly NAMESPACE = "counter";

    constructor(adapter: CounterAdapter, options: McpBehaviorOptions = {}) {
        super(adapter, { ...options, namespace: options.namespace ?? CounterBehavior.NAMESPACE });
    }

    protected override _buildResources(): McpResource[] {
        return [{ uri: CounterAdapter.URI, name: "Counter", mimeType: "application/json" }];
    }

    protected override _buildTools(): McpTool[] {
        return [
            {
                name: "counter_increment",
                description: "Add `by` (default 1) to the counter and return its new value.",
                inputSchema: {
                    type: "object",
                    properties: { by: { type: "number", description: "Increment amount." } },
                    additionalProperties: false,
                },
            },
            {
                name: "counter_reset",
                description: "Reset the counter to zero.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
        ];
    }
}

// 4. Server: wire transport + behaviors.
const adapter = new CounterAdapter();
const server = new McpServerBuilder()
    .withName("counter-demo")
    .withTransport(new StdioTransport())
    .register(new CounterBehavior(adapter))
    .build();

await server.start();
```

Save as `server.ts`, build, run with `node server.js`. Any MCP client (Claude Desktop, an SDK, a hand-rolled JSON-RPC over stdio) can now call `counter_increment` and `counter_reset` and read `app://counter`.

## The Grammar layer

A grammar is a set of **description overrides** that the server applies on top of the behavior's baseline schemas before sending them to the client. The grammar layer is **modular**: multiple grammars can coexist in the same server and be selected per session by source (the calling client), by target (LLM provider, prompt dialect), or by locale. They are also **layered**: store overrides win over static, both override the behavior fallback.

### Static grammars selected per client

```ts
import { McpGrammar } from "@cyanmycelium/mcp-core";

const concise = McpGrammar.fromJSON({
    counter_increment: {
        description: "Add `by` to the counter.",
        properties: { by: "How much to add." },
    },
});

const verbose = McpGrammar.fromJSON({
    counter_increment: {
        description:
            "Atomically increments the in-memory counter by the given amount " +
            "and returns the new value. The previous value is not retained.",
    },
});

const server = new McpServerBuilder()
    .withName("counter-demo")
    .withTransport(new StdioTransport())
    .withGrammar("concise", concise)
    .withGrammar("verbose", verbose)
    .withGrammarResolver((clientInfo) =>
        clientInfo.name.toLowerCase().includes("claude") ? "concise" : "verbose",
    )
    .register(new CounterBehavior(adapter))
    .build();
```

Claude sees the short description, every other client sees the long one. **No conditional code in the behavior**.

### Internationalization (i18n)

Grammar selection is just a string key resolved per session, so the same mechanism that chooses a verbose vs concise variant also chooses a locale. Register one grammar per language and route by whatever is available (server-level config, client metadata, request headers in a custom transport):

```ts
const en = McpGrammar.fromJSON({
    counter_increment: {
        description: "Add `by` (default 1) to the counter and return its new value.",
        properties: { by: "Increment amount." },
    },
});

const fr = McpGrammar.fromJSON({
    counter_increment: {
        description: "Ajoute `by` (1 par défaut) au compteur et retourne sa nouvelle valeur.",
        properties: { by: "Quantité à ajouter." },
    },
});

const locale = (process.env.LOCALE ?? "en").toLowerCase();

const server = new McpServerBuilder()
    .withName("counter-demo")
    .withTransport(new StdioTransport())
    .withGrammar("en", en)
    .withGrammar("fr", fr)
    .withGrammarResolver(() => locale)
    .register(new CounterBehavior(adapter))
    .build();
```

Tool descriptions, property descriptions, and any other agent-visible string are localized through the same selection layer that handles per-client variants. Combine the two axes by returning a composite key (e.g. `claude-fr`) and registering a grammar for each.

### Runtime mutation by the agent itself

`McpGrammarBehavior` exposes the grammar store as a regular MCP behavior with six tools (`grammar_list`, `grammar_read`, `grammar_set`, `grammar_delete`, `grammar_import`, `grammar_export`). The agent can rewrite its own tool descriptions during a session, and the server emits `notifications/tools/list_changed` so clients re-fetch the updated schemas.

```ts
import { McpGrammarBehavior, McpGrammarStore } from "@cyanmycelium/mcp-core";

const store = new McpGrammarStore();

const server = new McpServerBuilder()
    .withName("counter-demo")
    .withTransport(new StdioTransport())
    .withGrammarStore(store)
    .register(new CounterBehavior(adapter), new McpGrammarBehavior(store))
    .build();
```

Persist `store.toJSON()` to disk between runs to keep agent-authored descriptions across restarts.

## Per-resource tool support

The adapter declares which tools apply to which resource types. The behavior filters tools accordingly before advertising them.

```ts
import { ToolSupport } from "@cyanmycelium/mcp-core";

class CameraAdapter extends McpAdapterBase {
    public override getToolSupport(
        toolName: string,
        resourceType?: string,
    ): ToolSupport | undefined {
        if (toolName === "camera_orbit" && resourceType === "fixed-camera") {
            return ToolSupport.None;  // hidden from tools/list for fixed cameras
        }
        if (toolName === "camera_follow_path" && resourceType === "fps-camera") {
            return ToolSupport.Partial;  // visible, but with caveats in description
        }
        return undefined;  // Full (default)
    }
}
```

The client never sees tools it cannot actually call. No error spam.

## URI templates (RFC 6570)

Declare templated resources so clients can discover the URI shape without enumerating every instance.

```ts
protected override _buildTemplate(): McpResourceTemplate[] {
    return [{
        uriTemplate: "app://camera/{cameraId}",
        name: "Camera",
        description: "Any camera in the active scene, by id.",
        mimeType: "application/json",
    }];
}
```

When a tool call arrives with a concrete URI (`app://camera/main`), the server matches it against templates if no exact static resource matches. The adapter receives the resolved URI and can parse the variables itself.

## One behavior, many adapters

The behavior owns the schemas. The adapter owns the execution. Any adapter that satisfies the contract can be paired with the same behavior, so the same tool catalog runs against different backends without rewriting a single schema.

Reusing the `CounterBehavior` from the Quick start:

```ts
import { IMcpBehaviorAdapter } from "@cyanmycelium/mcp-core";

const behavior = (adapter: IMcpBehaviorAdapter) =>
    new CounterBehavior(adapter, { namespace: "counter" });

// Same tools, different execution backends.
server.register(behavior(new InMemoryCounterAdapter()));   // tests, demos
server.register(behavior(new RedisCounterAdapter(redis))); // production
server.register(behavior(new DbCounterAdapter(db)));       // persisted
```

The pattern scales to richer domains: a single behavior describing mesh operations can run against a BabylonJS scene, a Cesium viewer, or an in-memory fixture, with the LLM-facing schemas never changing.

## Transports

| Transport | Module | Use case |
|---|---|---|
| `DirectTransport` | `@cyanmycelium/mcp-core/server` | One server, one WebSocket. The default. |
| `MultiplexTransport` | `@cyanmycelium/mcp-core/server` | Multiple servers sharing one WebSocket via envelope routing. |
| `LoopbackTransport` | `@cyanmycelium/mcp-core/server` | Server and client in the same process. Tests, local dev, embedded use. |
| `StdioTransport` | `@cyanmycelium/mcp-core/node` | Line-delimited JSON-RPC over stdin/stdout. The MCP standard for CLI agents. |

Implement `IMessageTransport` for anything else (WebRTC, postMessage, gRPC).

## Package layout

```
src/
  index.ts                       interfaces + behavior/adapter/grammar + tool results
  interfaces/                    all shared contracts (one file per topic + barrel)
  mcp.adapter.ts                 McpAdapterBase
  mcp.behavior.ts                McpBehavior (extends McpBehaviorBase)
  mcp.behaviorBase.ts            McpBehaviorBase, McpBehaviorOptions(Builder)
  mcp.grammar.ts                 McpGrammar (layer + merge + fromJSON/toJSON)
  mcp.grammarStore.ts            McpGrammarStore (persistable, observable)
  mcp.grammarBehavior.ts         McpGrammarBehavior (store exposed as MCP behavior)
  mcp.toolResult.ts              McpToolResults.{text,json,resource,image,error}
  server/                        McpServer, McpServerBuilder, JSON-RPC helpers, transports
  client/                        McpClient
  llm/                           LLM bridge interfaces and a generic client
  node/                          Node-only transports (StdioTransport)
```

## Development

```sh
npm install
npm run build      # tsc -b tsconfig.build.json
npm test           # vitest run
npm run lint
npm run lint:fix
npm run format:fix
```

Requires Node 20.11+.

## License

Apache-2.0. See [LICENSE](./LICENSE).
