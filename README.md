[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-core)](https://www.npmjs.com/package/@cyanmycelium/mcp-core)
[![CI](https://github.com/pandaGaume/mcp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pandaGaume/mcp-core/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @cyanmycelium/mcp-core

Engine-neutral primitives for building [Model Context Protocol](https://modelcontextprotocol.io/) servers and clients in TypeScript.

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

Wiring a server to a real client is covered in **[HOWTO.md](HOWTO.md)**: stdio for the clients installed on a machine (Claude Desktop, Claude Code, Codex), HTTPS for the ones running on a vendor's servers (Claude.ai in a browser, ChatGPT on the web), and how to tell which case you are in.

## Runtimes

Runs in both Node.js and the browser, and implements the two transports the MCP specification defines: stdio and Streamable HTTP, plus `LoopbackTransport` for a server and client sharing a process.

Roles matter here, because a transport means two opposite things depending on which end you are. A server launched as a subprocess speaks through its own `stdin`/`stdout`; the client that launched it speaks through the child's. Over HTTP, one side issues requests and the other terminates them.

| Transport | Server side | Client side |
|---|---|---|
| stdio | `StdioTransport` | `ChildProcessTransport` |
| Streamable HTTP | `StreamableHttpEndpoint` | `StreamableHttpTransport` |
| loopback | `LoopbackTransport` (both ends of one pair) | |

Both standard transports, both roles.

## What to import for what

| What you are building | Packages | Piece to use |
|---|---|---|
| MCP server launched as a subprocess (Claude Desktop, a CLI agent) | `mcp-core` | `StdioTransport` |
| MCP server reachable over HTTP by remote clients | `mcp-core` | `StreamableHttpEndpoint` |
| MCP client talking to a remote server | `mcp-core` | `StreamableHttpTransport` |
| MCP server and client inside one process | `mcp-core` | `LoopbackTransport` |
| MCP server inside a browser, exposed to the outside | `mcp-core` + [`mcp-broker-provider`](https://www.npmjs.com/package/@cyanmycelium/mcp-broker-provider) | `MultiplexTransport` |
| Several servers federated behind one endpoint, with central auth | the above, plus [`mcp-broker`](https://www.npmjs.com/package/@cyanmycelium/mcp-broker) **run as a process** | n/a |
| MCP client driving a third-party server as a subprocess (`npx some-mcp-server`) | `mcp-core` | `ChildProcessTransport` |

Two readings that trip people up.

A Node MCP server needs **nothing but this package**. The broker is a relay, not a way to write a server. You reach for it when you have several servers to federate, credentials to centralise, or browsers to get out of, not to expose one server.

And the broker is a process you run (`npx @cyanmycelium/mcp-broker`), not a dependency you bundle. Your server stays on `mcp-core` and publishes itself into a slot; what you pay is an extra process, not extra code in your artifact.

The WebSocket tunnel to that broker is CyanMycelium topology rather than protocol, which is why it lives in `mcp-broker-provider` and not here: this package stays a faithful implementation of the specification and nothing else.

## Protocol coverage

Revisions accepted during the handshake: `2025-11-25` (default), `2025-06-18`, `2025-03-26`, `2024-11-05`. The server echoes the revision the client requested when it appears in that list, and answers with its newest otherwise; the client announces `2025-11-25` and disconnects if the server replies with a revision it cannot speak. Narrow the accepted set with `withOptions({ protocolVersions: [...] })`, or pin one revision by returning `protocolVersion` from your `IMcpInitializer`.

| Area | Status |
|---|---|
| `initialize`, version negotiation, `notifications/initialized` | yes |
| `tools/list`, `tools/call`, `notifications/tools/list_changed` | yes |
| `resources/list`, `resources/templates/list`, `resources/read`, `notifications/resources/list_changed` | yes |
| `structuredContent` and `outputSchema` on tools | yes |
| `title`, `icons`, `annotations`, `_meta` on tools, resources and templates | yes |
| Binary resources (`blob`), `audio` and `resource_link` content blocks | yes |
| `ping` (both directions) | yes |
| Pagination (`cursor` / `nextCursor`) | client follows it; server returns single pages |
| Prompts, resource subscriptions, logging, completion | not yet |
| Progress, cancellation, sampling, roots, elicitation, tasks | not yet |
| Transports | stdio and Streamable HTTP, both roles each, plus loopback |
| Streamable HTTP: sessions, `MCP-Protocol-Version`, SSE resumption, `DELETE` teardown | yes |
| OAuth 2.1 resource server: RFC 9728 metadata, `WWW-Authenticate` challenges, audience-bound tokens, 401/403 | yes, server side |
| OAuth client flow: metadata discovery, PKCE, `resource` parameter, step-up | not yet: supply a token via `IStreamableHttpTransportOptions.headers` |

Tool execution failures come back as `isError: true` results rather than JSON-RPC errors, which is what the spec asks for so the model can self-correct. Protocol errors stay protocol errors: an unknown tool is `-32602`, an unknown resource `-32002`, a JSON-RPC batch `-32600` (batching was removed from MCP in `2025-06-18`).

`McpResourceContent` is a union of a text and a binary variant, so reading one means narrowing on the field you need:

```ts
const content = await client.readResource("app://logo");
const bytes = content.text !== undefined ? Buffer.from(content.text) : Buffer.from(content.blob, "base64");
```

## Subpath entry points

```ts
import { McpBehavior, McpAdapterBase, McpGrammar, McpToolResults } from "@cyanmycelium/mcp-core";
import { negotiateProtocolVersion, parseChallengeHeader }          from "@cyanmycelium/mcp-core"; // protocol + auth primitives
import { McpServer, McpServerBuilder, LoopbackTransport }          from "@cyanmycelium/mcp-core/server";
import { McpClient }                                               from "@cyanmycelium/mcp-core/client";
import { LlmClient }                                               from "@cyanmycelium/mcp-core/llm";
import { StdioTransport, ChildProcessTransport,
         StreamableHttpTransport, StreamableHttpEndpoint }         from "@cyanmycelium/mcp-core/node"; // Node-only
```

Tree-shaking ensures browser bundles never pull `node:*` modules.

The root entry point holds everything that depends on nothing: the behavior stack, protocol-version negotiation, and the OAuth pieces (metadata document, challenge building **and parsing**, canonical resource URI). They sit there rather than under `/node` because a browser client needs the same pieces in reverse: it parses the challenge a server builds.

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

A grammar is a set of **description overrides** that the server applies on top of the behavior's baseline schemas before sending them to the client. The grammar layer is **modular**: multiple grammars can coexist in the same server and be selected per session by source (the calling client), by target (LLM provider, prompt dialect), or by locale.

As of 0.3.0, four layers stack with explicit precedence (low → high):

| # | Layer | Owner | When to use |
|---|---|---|---|
| 1 | Behavior | The behavior class (`_buildGrammars()`) | The behavior ships its own multi-language baselines, autonomous, no external file required |
| 2 | Adapter | The behavior's adapter (`getGrammar(key)`) | Engine-specific binding nudges a few descriptions without forking the behavior |
| 3 | Static | Application (`builder.withGrammar(key, g)`) | App-wide override at build time (replaces a baseline for every session) |
| 4 | Store | Runtime (`McpGrammarStore`, via `McpGrammarBehavior`) | The agent (or operator) edits live descriptions per-profile, with `tools/list_changed` notifications |

`McpGrammar.merge(...layers)` aggregates them in priority order: same-key entries in later layers win, missing entries cascade from earlier ones. The behavior is never required to know about static, store, or adapter layers: they merge transparently at the server.

What a grammar may override, per session:

| Target | Fields | Lookup key |
|---|---|---|
| Tool | `title`, `description`, and each `inputSchema` property description (dot-notation for nested objects, e.g. `"patch.position"`) | tool name |
| Resource | `name`, `title`, `description` | resource `uri` |
| Resource template | `name`, `title`, `description` | `uriTemplate` |

`title` is the display name a client shows instead of the programmatic `name`, so it is the field to localise; `name` stays stable because clients and models address tools by it.

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

### Behavior-owned multi-language baselines

Since 0.3.0, a behavior can ship its own grammars in code (one entry per `<agent>:<locale>[@version]` key it supports) without any external JSON files or broker layer. The application becomes autonomous on i18n; the broker is only needed if you want operator-editable overrides at runtime.

```ts
import { McpBehavior, McpGrammar } from "@cyanmycelium/mcp-core";

class CounterBehavior extends McpBehavior {
    protected override _buildGrammars(): Map<string, McpGrammar> {
        return new Map([
            ["default:en", McpGrammar.fromJSON({
                tools: { counter_increment: {
                    description: "Add `by` (default 1) to the counter and return its new value.",
                    properties: { by: "Increment amount." },
                }},
            })],
            ["default:fr", McpGrammar.fromJSON({
                tools: { counter_increment: {
                    description: "Ajoute `by` (1 par défaut) au compteur et retourne sa nouvelle valeur.",
                    properties: { by: "Quantité à ajouter." },
                }},
            })],
            ["claude:fr", McpGrammar.fromJSON({
                tools: { counter_increment: {
                    description: "Incrément atomique du compteur. Renvoie la valeur post-mutation.",
                }},
            })],
        ]);
    }
    // _buildTools(), executeToolAsync(), etc.
}
```

### The `withGrammarResolver` policy

`withGrammarResolver` accepts two forms. Pass a custom function for arbitrary logic, or a declarative `GrammarResolverOptions` to use the built-in `<agent>:<locale>[@version]` composer:

```ts
import { McpServerBuilder } from "@cyanmycelium/mcp-core";

// Declarative: locale + agent + (opt-in) version with progressive narrowing.
const server = new McpServerBuilder()
    .withName("counter-demo")
    .withTransport(new StdioTransport())
    .register(new CounterBehavior(adapter))
    .withGrammarResolver({
        localeSource: (_, caps) => caps?.locale ?? process.env.LOCALE,
        // versionFrom: (_, caps) => caps?.protocolVersion,   // opt-in
    })
    .build();
```

For a Claude client requesting locale `fr-CA`, the resolver emits the chain `["claude:fr-ca", "claude:fr", "default:fr-ca", "default:fr", "claude:en", "default:en"]`. The server tries each in order and picks the first key for which at least one of the four layers has registered a grammar: so the behavior's `default:fr` matches even when a more specific Canadian-French variant is not shipped.

The fallback narrowing order (`["version", "locale-region", "locale", "agent"]` by default) and key composition are both customizable; see `GrammarResolverOptions` for the full surface.

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

A server never opens its own connection: it is handed a transport, and `withTransport()` is required before `build()`. Framing, reconnection and authentication belong to whoever understands the medium.

| Transport | Module | Use case |
|---|---|---|
| `StdioTransport` | `@cyanmycelium/mcp-core/node` | Line-delimited JSON-RPC over **this** process's stdin/stdout, for a server that someone else launched. |
| `ChildProcessTransport` | `@cyanmycelium/mcp-core/node` | The mirror: launches an MCP server as a subprocess and speaks to **its** stdio. How most published servers are actually run. |
| `StreamableHttpTransport` | `@cyanmycelium/mcp-core/node` | The MCP standard for remote servers: POST plus an SSE stream, with sessions and resumption. Client side. |
| `StreamableHttpEndpoint` | `@cyanmycelium/mcp-core/node` | The same transport, server side, as a `(req, res)` handler you mount on your own HTTP server. |
| `LoopbackTransport` | `@cyanmycelium/mcp-core/server` | Server and client in the same process. Tests, local dev, embedded use. |

Implement `IMessageTransport` for anything else (WebRTC, postMessage, gRPC). The WebSocket tunnel to a CyanMycelium broker lives in [`@cyanmycelium/mcp-broker-provider`](https://www.npmjs.com/package/@cyanmycelium/mcp-broker-provider), which is where `DirectTransport` and `MultiplexTransport` moved in `0.5.0`.

### Driving a server you launch

`ChildProcessTransport` is what lets an `McpClient` use the servers people actually publish, which ship as a command rather than a listening endpoint:

```ts
import { McpClient } from "@cyanmycelium/mcp-core/client";
import { ChildProcessTransport } from "@cyanmycelium/mcp-core/node";

const transport = new ChildProcessTransport({
    command: "npx",
    args: ["-y", "some-mcp-server"],
    // stdio servers take their credentials from the environment: the spec
    // reserves the OAuth flow for HTTP transports.
    env: { API_TOKEN: process.env.API_TOKEN ?? "" },
    stderr: (line) => console.warn(`[server] ${line}`),
});

const client = new McpClient({ name: "my-agent", version: "1.0.0" }, transport);
await client.connect();
```

`close()` follows the shutdown sequence the spec prescribes rather than killing outright: it closes the child's stdin so the server can finish on its own, sends `SIGTERM` if it lingers, then `SIGKILL`. Await `transport.exited` to know when the process is really gone.

A line on `stderr` means nothing is wrong: servers are explicitly allowed to log anything there, so it is routed to you and never mistaken for protocol.

### Reaching a remote server

`StreamableHttpTransport` connects an `McpClient` to a remote MCP endpoint:

```ts
import { McpClient } from "@cyanmycelium/mcp-core/client";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";

const transport = new StreamableHttpTransport("https://example.com/mcp", {
    // A function, not an object: read fresh per request, so rotating the token
    // takes effect without rebuilding the transport and losing the session.
    headers: () => ({ Authorization: `Bearer ${tokens.current}` }),
});
const client = new McpClient({ name: "my-agent", version: "1.0.0" }, transport);
await client.connect();
```

A plain object works too and is snapshotted at construction. OAuth itself is not implemented: the transport carries whatever credential you give it, and does not yet discover an authorization server or run a token flow.

### Serving Streamable HTTP

`StreamableHttpEndpoint` is the other half: a request handler, not a server. It opens no socket, so listening, TLS and routing stay with your application while sessions, framing and the protocol's status codes stay with the package.

```ts
import { createServer } from "node:http";
import { McpServerBuilder } from "@cyanmycelium/mcp-core/server";
import { StreamableHttpEndpoint } from "@cyanmycelium/mcp-core/node";

const endpoint = new StreamableHttpEndpoint({
    // One MCP server per session: a negotiated revision and a resolved grammar
    // belong to one client. Behaviors are shared: they point at your state.
    createServer: (transport) => new McpServerBuilder().withName("my-app").withTransport(transport).register(behavior).build(),
    allowedOrigins: ["https://app.example.com"],
});

createServer((req, res) => void endpoint.handleRequest(req, res)).listen(3000);
```

Mount it the same way in Express or Fastify. A `POST` carrying a request is answered as `application/json`; notifications get `202`; server-initiated messages travel on the standalone `GET` stream. Session ids are issued on the `initialize` response and required afterwards, `DELETE` terminates a session, and a request naming a terminated one gets `404` so the client knows to re-initialize.

`Origin` is validated and refused with `403` unless listed in `allowedOrigins`, which is closed by default: without that check any web page can drive a local MCP server through DNS rebinding. A request with no `Origin` header cannot come from a browser and is allowed.

### Protecting it with OAuth

Pass `auth` and the endpoint becomes an OAuth 2.1 protected resource: it validates the bearer token, answers `401` and `403` with the RFC 9728 challenge, and hands the validated principal to your factory.

```ts
const endpoint = new StreamableHttpEndpoint({
    createServer: (transport, sessionId, principal) => buildServerFor(transport, principal),
    auth: {
        resource: "https://mcp.example.com/mcp", // RFC 8707 canonical URI; tokens must name it
        validator: myTokenValidator,             // you verify the token, however you like
        authorizationServers: ["https://auth.example.com"],
        metadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        requiredScopes: ["mcp:call"],
    },
});

// Serve the discovery document yourself, unauthenticated, since a client
// fetches it precisely because it has no token yet.
endpoint.protectedResourceMetadata();
```

MCP defines no token format and no authorization server, so neither does this package: `ITokenValidator` is the single seam, and verifying a JWT stays with your application. Everything above it (the metadata document, the challenge header and its parser, the canonical resource URI, the 401/403 semantics) lives in `@cyanmycelium/mcp-core` itself rather than under `/node`, because a client needs the same pieces in reverse and they depend on nothing.

The client hands the negotiated revision to the transport, which stamps `MCP-Protocol-Version` on every subsequent request. Session ids are captured and echoed automatically, the standalone GET stream is opened after initialization (with or without a session) and re-established with `Last-Event-ID` when the server closes it, honouring the SSE `retry` delay. A session terminated server-side (HTTP 404) surfaces as a transport close, since recovering means a fresh `initialize`; call `client.connect()` again to start a new session. `close()` sends an HTTP DELETE to release the session.

## Package layout

```
src/
  index.ts                       everything isomorphic, re-exported
  interfaces/                    all shared contracts (one file per topic + barrel)
  mcp.protocol.ts                revisions supported + version negotiation
  mcp.auth.ts                    OAuth resource-server primitives (metadata, challenge, RFC 8707 URI)
  mcp.adapter.ts                 McpAdapterBase
  mcp.behavior.ts                McpBehavior (extends McpBehaviorBase)
  mcp.behaviorBase.ts            McpBehaviorBase, McpBehaviorOptions(Builder)
  mcp.grammar.ts                 McpGrammar (layer + merge + fromJSON/toJSON)
  mcp.grammarStore.ts            McpGrammarStore (persistable, observable)
  mcp.grammarBehavior.ts         McpGrammarBehavior (store exposed as MCP behavior)
  mcp.toolResult.ts              McpToolResults.{text,json,resource,link,image,audio,error}
  mcp.resolver.ts                grammar key resolution from client identity
  server/                        McpServer, McpServerBuilder, JSON-RPC helpers, LoopbackTransport
  client/                        McpClient
  llm/                           LLM bridge interfaces and a generic client
  node/                          Node-only: StdioTransport, ChildProcessTransport,
                                 StreamableHttpTransport, StreamableHttpEndpoint
```

The split is deliberate: anything that touches `node:*` lives under `node/`, everything else is isomorphic. That is why the OAuth and protocol primitives sit at the root while the HTTP wiring that uses them does not.

## Development

```sh
npm install
npm run build      # tsup, bundles each entry point, emits .d.ts
npm run typecheck  # tsc --noEmit, the only type gate: tsup transpiles without checking
npm test           # vitest run
npm run lint
npm run lint:fix
npm run format:fix
```

Requires Node 20.11+.

`typecheck` is not redundant with `build`. tsup strips types rather than verifying them, and vitest does the same, so without it nothing would ever check the sources or the tests. It runs in CI between `build` and `test`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
