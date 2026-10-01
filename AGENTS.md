# AGENTS.md, mcp-core

Read this file first. It is written for an AI coding agent told "build an MCP server (or client) with `@cyanmycelium/mcp-core`" with no prior knowledge, and it is meant to be enough on its own. The [README](README.md) is the long form; [HOWTO.md](HOWTO.md) covers registering a server with Claude and ChatGPT.

## 1. What this is, and the one decision

An engine-neutral implementation of the Model Context Protocol: server, client, transports, and a behavior/adapter layer that keeps the schemas an LLM sees apart from the code that executes them. It speaks revisions `2025-11-25` (default), `2025-06-18`, `2025-03-26` and `2024-11-05`.

| your situation | do this |
|---|---|
| Expose your app to an MCP host (Claude Desktop, Claude Code, Codex) | `McpServerBuilder` + `StdioTransport` |
| Expose it over HTTP | `McpServerBuilder` inside `StreamableHttpEndpoint({ createServer })`, mounted on your own HTTP server |
| Run it in a browser, or publish it into a CyanMycelium broker slot | `McpServerBuilder` + a transport from `@cyanmycelium/mcp-broker-provider` (`DirectTransport` / `MultiplexTransport`) |
| Server and client in one process (tests, embedding) | `LoopbackTransport.createPair()` |
| Drive someone else's server | `McpClient` + `ChildProcessTransport` (a command) or `StreamableHttpTransport` (a URL) |

## 2. What to import from where

```ts
import { McpAdapterBase, McpBehavior, McpToolResults } from "@cyanmycelium/mcp-core";        // behavior stack, protocol, auth primitives
import { McpServer, McpServerBuilder, LoopbackTransport } from "@cyanmycelium/mcp-core/server";
import { McpClient } from "@cyanmycelium/mcp-core/client";
import { StdioTransport, ChildProcessTransport, StreamableHttpTransport, StreamableHttpEndpoint } from "@cyanmycelium/mcp-core/node"; // Node only
```

Everything also re-exports from the root. `/node` is the only entry that touches `node:*`; never import it in a browser bundle.

## 3. The shape of a server

**A behavior owns the schemas, an adapter owns the execution.** The server derives its capabilities from what the registered behaviors expose; you never declare them.

```ts
class GaugeAdapter extends McpAdapterBase {
    private _value = 0;
    constructor() { super("plant"); }

    async readResourceAsync(uri: string) {
        return uri === "plant://gauge" ? { uri, mimeType: "application/json", text: JSON.stringify({ value: this._value }) } : undefined;
    }
    async executeToolAsync(_uri: string, tool: string, args: Record<string, unknown>) {
        if (tool !== "gauge_set") return McpToolResults.error(`unknown tool: ${tool}`);
        this._value = Number(args.value);
        this._forwardResourceContentChanged("plant://gauge"); // see §4
        return McpToolResults.json({ value: this._value });
    }
}

class GaugeBehavior extends McpBehavior {
    constructor(adapter: GaugeAdapter) { super(adapter, { namespace: "gauge" }); }
    protected override _buildResources() { return [{ uri: "plant://gauge", name: "Gauge", mimeType: "application/json" }]; }
    protected override _buildTools() {
        return [{ name: "gauge_set", description: "Set the gauge.", inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }];
    }
}

const server = new McpServerBuilder().withName("plant").withTransport(new StdioTransport()).register(new GaugeBehavior(new GaugeAdapter())).build();
await server.start();
```

- A throwing tool becomes an `isError: true` result, not a JSON-RPC error: the model can read it and retry.
- Templated resources: override `_buildTemplate()` and return `{ uriTemplate: "plant://sensor/{id}", ... }`; `resources/read`, `tools/call` with a `uri` argument, and `resources/subscribe` all match against it.
- **Over stdio, nothing but protocol on stdout.** Log to stderr.
- **Who is asking (1.4.0).** `readResourceAsync`, `executeToolAsync`, `getPromptAsync` and `completeAsync` take an optional last argument, `request?: IMcpRequestContext`: `{ requestId, method, meta? }`, where `meta` is the request's `params._meta` verbatim (shallow-copied, frozen; left out when absent or not an object). A relay passes caller information there under its own reverse-DNS key, e.g. `request?.meta?.["io.cyanmycelium/caller"]`. Treat every value as untrusted input. An adapter that omits the parameter keeps working unchanged. The **root** resource of an `McpBehavior` is cached and shared by all callers, so it is built without the request: serve caller-dependent content on instance URIs.

## 4. Change notifications (1.3.0)

A behavior never sends a notification. It **reports a change**, and the server decides who hears it.

| you call (in an `McpAdapterBase`) | the client receives |
|---|---|
| `this._forwardResourceContentChanged(uri)` | `notifications/resources/updated`, **only** if that session subscribed to exactly `uri` |
| `this._forwardResourceChanged()` | `notifications/resources/list_changed`; the server re-indexes resources first |

- The server advertises `resources: { subscribe: true, listChanged: true }` as soon as a behavior has a resource or a template, and answers `resources/subscribe` / `resources/unsubscribe` itself. Subscriptions are per session, matched byte for byte, and forgotten on disconnect.
- Subscribing to a URI nothing can read is `-32002`. Unsubscribing never fails.
- `McpBehavior` drops its cached copy of a changed resource before forwarding, so the client's re-read is fresh. Without the call, the root resource is served from cache forever.
- A behavior written without `McpBehavior` implements the optional `onResourceUpdated`, `onResourcesListChanged` and `onPromptsChanged` event sources itself.
- Content with no behavior behind it: `server.notifyResourceUpdated(uri)` returns whether anything was sent.
- Client side: `client.onResourceUpdated.subscribe((uri) => ...)`, then `await client.subscribeResource(uri)`.
- One server per HTTP session (`StreamableHttpEndpoint` does this): a subscription belongs to one client.

## 5. Prompts, completion, logging (1.3.0)

Add these methods to a behavior; each capability is advertised only when some behavior provides it.

```ts
getPrompts(): McpPrompt[] { return [{ name: "summarize", arguments: [{ name: "topic", required: true }] }]; }
async getPromptAsync(name: string, args: Record<string, string>) {
    return { messages: [{ role: "user", content: { type: "text", text: `Summarize ${args.topic}` } }] };
}
async completeAsync(ref: McpCompletionReference, argument: McpCompletionArgument) {
    return { values: TOPICS.filter((t) => t.startsWith(argument.value)) }; // capped at 100 by the server
}
```

- `prompts/get`: unknown name, missing required argument, non-string value: all `-32602`. `onPromptsChanged` sends `notifications/prompts/list_changed`.
- `completion/complete` goes to the behavior that lists the prompt (`ref/prompt`) or declares the `uriTemplate` (`ref/resource`).
- Logging is **off by default**. `withOptions({ logging: true })` advertises it, answers `logging/setLevel`, and makes `server.log(level, data, logger?)` emit `notifications/message` at or above the client's level (`info` until set).

## 6. Transports and what `start()` means

`await server.start()` resolves when **the transport reports itself open**, not when a peer accepted it. Over a tunnel (broker slot, relay, proxy) a refusal arrives afterwards. Subscribe before starting:

```ts
server.onTransportError?.subscribe((e) => console.warn("transport:", e.message));
server.onDisconnected?.subscribe(() => console.warn("closed; the next session renegotiates"));
```

Log "connected" when the first `initialize` arrives, never after `start()`.

`StreamableHttpEndpoint` refuses browser `Origin`s with `403 invalid_origin` unless listed in `allowedOrigins` (closed by default, compared verbatim: scheme, host, port, no trailing slash). Requests without `Origin` pass.

## 7. Spec coverage

Every request a client may send is listed per revision in `MCP_SERVER_REQUEST_METHODS`. `tests/spec.coverage.test.ts` sends each one to a server and fails on `-32601` unless the method is in `MCP_SERVER_UNSUPPORTED_METHODS` with a reason. **When a new revision lands, add its methods there first**: the test then says what is missing.

| method family | status |
|---|---|
| `initialize`, `ping`, `tools/*`, `resources/list`, `resources/templates/list`, `resources/read` | yes |
| `resources/subscribe`, `resources/unsubscribe`, `prompts/*`, `completion/complete`, `logging/setLevel` | yes since 1.3.0 |
| `tasks/*` (experimental in `2025-11-25`) | declared unsupported, `-32601` |
| sampling, roots, elicitation (server-to-client) | the client answers `-32601` |
| OAuth client flow | not implemented; pass a token through transport `headers` |
| Pagination | the client follows `nextCursor`; the server returns single pages |

A custom `IMcpServerHandlers` written before 1.3.0 keeps compiling and working: the handlers added since are optional and the server falls back to its own.

## 8. Symptom to fix

| symptom | cause | fix |
|---|---|---|
| `start()` resolved, the peer never talks | a tunnel refused the slot after open | read `onTransportError`; see §6 |
| Host says the server crashed, JSON parse errors | something wrote to stdout under `StdioTransport` | log to stderr only |
| `403 invalid_origin` | the browser origin is not in `allowedOrigins` | list it exactly, scheme and port included |
| `resources/subscribe` answers `-32002` | the URI is neither a listed resource nor a template match | expose it, or subscribe to the URI you actually serve |
| Subscribed, `notifications/resources/updated` never arrives | the adapter never called `_forwardResourceContentChanged(uri)`, or with a different string | call it with the exact URI the client subscribed to |
| A read after a change returns the old content | the change was not reported, so the cache was not dropped | report it (§4) |
| `list_changed` never arrives | the client never sent `notifications/initialized`; list notifications wait for it | complete the handshake (`McpClient.connect()` does) |
| `logging/setLevel` answers `-32601` | logging is off | `withOptions({ logging: true })` |
| `prompts` / `completions` not in the capabilities | no behavior returns prompts / implements `completeAsync` | add them to a behavior (§5) |
| `-32602 Unknown tool` | the name is not in any behavior's `_buildTools()`, or the adapter declared it `Planned` / `None` | check `getToolSupport` |

## 9. Anti-goals, stated plainly

- `start()` resolving is **not** a connection guarantee.
- A server does **not** own its connection: no reconnect, no framing, no auth. That is the transport's business.
- Resource URIs are **not** normalized. `plant://gauge` and `plant://gauge/` are two subscriptions.
- Subscriptions do **not** survive a disconnect; the client re-subscribes after reconnecting.
- One `McpServer` serves **one** session. Share behaviors across sessions, not servers.
- The broker tunnel is **not** here: it is `@cyanmycelium/mcp-broker-provider`. This package stays a faithful implementation of the spec and nothing else.
