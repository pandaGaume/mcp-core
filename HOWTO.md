# How to connect your server to Claude and to ChatGPT

A server built on `@cyanmycelium/mcp-core` can be reached by either, but not the same way, and the difference is not a matter of preference. This page covers both routes and the one question that decides between them.

Everything below was checked against the vendors' own documentation. Both move quickly; the transport and auth details are the parts most likely to have shifted, so verify before a production rollout.

## The decision that comes first

It is not a question of vendor. It is a question of **where the client runs**.

A client installed on a machine can start a process on that machine, so it can launch your server itself. A client running on the vendor's servers cannot: it has to reach your server over the network, at an address that resolves from their infrastructure. `localhost` is not such an address, and no configuration will make it one.

| Client | Runs | Transport | What you must provide |
|---|---|---|---|
| Claude Desktop | On the machine | stdio | Nothing but the command |
| Claude Code | On the machine | stdio, or remote HTTP | Nothing, or a URL |
| Codex, CLI, IDE extension, ChatGPT desktop app | On the machine | stdio, or Streamable HTTP | Nothing, or a URL |
| Claude.ai in a browser | On Anthropic's servers | Streamable HTTP | Public HTTPS endpoint, OAuth |
| ChatGPT on the web, OpenAI API | On OpenAI's servers | Streamable HTTP | Public HTTPS endpoint, OAuth |

So both vendors give you the local route through their installed clients, and both force the remote route through their hosted ones. What differs is only which of their surfaces you are targeting.

---

## Route 1: installed clients, over stdio

The cheapest route by a wide margin: no deployment, no TLS, no OAuth. The server is a command, and Claude runs it.

### Build it

```ts
import { McpServerBuilder } from "@cyanmycelium/mcp-core/server";
import { StdioTransport } from "@cyanmycelium/mcp-core/node";

const server = new McpServerBuilder()
    .withName("my-server")
    .withTransport(new StdioTransport())
    .register(new MyBehavior(new MyAdapter()))
    .build();

await server.start();
```

One rule, and it is absolute: **`stdout` carries the protocol and nothing else**. A stray `console.log` corrupts the JSON-RPC stream and the connection dies with an error that points nowhere near the cause. Log to `stderr`, which the spec reserves for exactly that and which Claude will not misread.

### Register it with Claude Desktop

Add it to `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "my-server": {
            "command": "node",
            "args": ["/absolute/path/to/dist/server.js"],
            "env": { "API_TOKEN": "..." }
        }
    }
}
```

Use absolute paths: the working directory Claude launches from is not yours. Restart Claude Desktop after editing.

### Register it with Claude Code

```bash
claude mcp add my-server -- node /absolute/path/to/dist/server.js
```

Then `/mcp` inside Claude Code shows the connection status, which is the fastest way to see whether the handshake succeeded.

### Register it with Codex

Codex reads TOML, at `~/.codex/config.toml` for a global server or `.codex/config.toml` for one scoped to a project:

```toml
[mcp_servers.my-server]
command = "node"
args = ["/absolute/path/to/dist/server.js"]
env_vars = ["API_TOKEN"]
```

Note the difference from Claude's JSON: `env_vars` lists the **names** of variables to forward from the surrounding environment, rather than mapping names to values. The secret stays where it already is instead of being copied into a config file, which is the better arrangement of the two.

The same file serves the Codex CLI, the IDE extension and the ChatGPT desktop app, so a server registered once is reachable from all three.

### Credentials

Pass them through `env`, as above. This is not a workaround: the specification explicitly says stdio implementations should take credentials from the environment rather than run the OAuth flow, which it reserves for HTTP transports.

---

## Route 2: hosted clients, over HTTPS

Claude.ai in a browser and ChatGPT on the web both reach a remote server, both speak Streamable HTTP, and both need a publicly reachable HTTPS URL. The installed clients can take this route too, which is what you want once one server serves several people.

### Build it

```ts
import { createServer } from "node:http";
import { McpServerBuilder } from "@cyanmycelium/mcp-core/server";
import { StreamableHttpEndpoint } from "@cyanmycelium/mcp-core/node";

const endpoint = new StreamableHttpEndpoint({
    createServer: (transport) =>
        new McpServerBuilder().withName("my-server").withTransport(transport).register(new MyBehavior(adapter)).build(),
    allowedOrigins: ["https://claude.ai"],
    auth: {
        resource: "https://mcp.example.com/mcp",
        validator: myTokenValidator,
        authorizationServers: ["https://auth.example.com"],
        metadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        requiredScopes: ["mcp:call"],
    },
});

createServer((req, res) => {
    // The discovery document must be reachable without a token: a client fetches
    // it precisely because it does not have one yet.
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(endpoint.protectedResourceMetadata()));
        return;
    }
    void endpoint.handleRequest(req, res);
}).listen(3000);
```

### TLS is not this package's job

`StreamableHttpEndpoint` is a request handler. It opens no socket and terminates no TLS, deliberately: listening and certificates belong to your deployment. In practice the certificate comes from a reverse proxy (Caddy, nginx, a cloud load balancer) or from `node:https` if you would rather hold it yourself.

For development, a tunnel is the usual answer: `cloudflared tunnel` or `ngrok http 3000` gives you a public HTTPS URL pointing at your local process, which is enough to test the whole flow including OAuth.

### What this package does for authorization, and what it does not

It implements the **resource server** half, which is the half the MCP specification defines: it publishes the RFC 9728 metadata document, validates that a token was issued for this exact resource, answers `401` and `403` with the challenge a client needs to recover, and hands you the validated principal.

It does **not** issue tokens. MCP defines no authorization server, so neither does this package, you point `authorizationServers` at one you already run or subscribe to, and `ITokenValidator` is where you plug in whatever verifies its tokens.

That leaves one thing to check before you pick an authorization server, and it is the most common cause of a connector that never finishes connecting:

- **Claude** has Dynamic Client Registration enabled and will try to register itself. If your authorization server does not support DCR, Claude also accepts custom credentials configured on the connector, so you have a way out.
- **OpenAI** recommends OAuth Client ID Metadata Documents (CIMD), with either public-client token exchange or a signed client assertion.

Both are **authorization-server** features. Neither is something a resource server can supply, so the requirement lands on whichever AS you choose, not on your MCP server.

### Register it

With Claude, add the URL under **Settings → Connectors**. With OpenAI, pass the URL as `server_url` on the MCP tool. For deep research through the API, OpenAI additionally requires the server to be configured so that no approval is required.

---

## So: is HTTPS really unavoidable?

Only for the hosted surfaces, and there it is unavoidable in a way no policy change will lift: the model runs on the vendor's infrastructure and calls your server from there, so the server has to exist at an address that resolves from outside your machine.

Everywhere else you have a genuine choice, and stdio is the one to take until something forces you off it:

| | stdio | remote HTTPS |
|---|---|---|
| Deployment | none | a host, a domain, a certificate |
| Authorization | an environment variable | an OAuth authorization server |
| Claude Desktop, Claude Code, Codex | yes | yes |
| Claude.ai in a browser, ChatGPT on the web | no | yes |
| Multiple users | one process each, launched by their own client | one server for everyone |

The honest summary: go stdio while the server is personal to whoever runs it, and go HTTPS the day it must serve several people, live somewhere permanent, or be reachable from a browser tab. Those tend to be the same day.

---

## Practical limits worth knowing before you design

Claude truncates a tool result at roughly 150,000 characters on Claude.ai and Desktop, and at 25,000 tokens in Claude Code, where `MAX_MCP_OUTPUT_TOKENS` can raise it. A tool that returns a large dataset should return a `resource_link` instead and let the client fetch what it needs.

Claude.ai and Desktop give up on a tool call after 300 seconds. Claude Code makes that configurable through `MCP_TOOL_TIMEOUT`.

Claude does not yet support resource subscriptions or sampling, so a design that depends on the server pushing resource updates will not work there. Notifications that the tool or resource *list* changed do work, and this package sends them.

---

## Checklist before you ship

Nothing on `stdout` but protocol, if you went stdio. Absolute paths in the client config. Credentials in `env`.

If you went HTTPS: a real certificate; the metadata document reachable **without** a token; `allowedOrigins` naming the clients you expect, since it is closed by default; an authorization server that supports DCR or CIMD, or custom credentials configured on the Claude side; and `resource` set to the exact canonical URI your tokens carry as audience, because a mismatch there fails as an opaque `401`.

Test with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) before wiring a real client. It exercises the handshake and the OAuth flow, and its errors are far more legible than a connector that silently refuses to appear.
