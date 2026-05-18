# @cyanmycelium/mcp-core

Engine-neutral primitives for building [Model Context Protocol](https://modelcontextprotocol.io/) servers and clients in TypeScript.

> Status: pre-release scaffolding (v0.0.0). Source code lands in v0.1.0.

## What this package provides

A layered stack for exposing live application state to LLM agents via MCP:

```
Behavior   identity, namespace, tool/resource schemas (MCP-side contract)
Adapter    runtime, executes against the actual host objects
State      serializable, read-only snapshots of those objects
Grammar    composable description overrides, resolved per session
```

Plus the wire layer: JSON-RPC server, builder, transports (direct, loopback, multiplex, stdio), and a matching client.

## Subpath entry points

```ts
import { McpBehavior, McpGrammar, McpToolResults } from "@cyanmycelium/mcp-core";
import { McpServer, McpServerBuilder }             from "@cyanmycelium/mcp-core/server";
import { McpClient }                               from "@cyanmycelium/mcp-core/client";
import { LlmClient }                               from "@cyanmycelium/mcp-core/llm";
import { StdioTransport }                          from "@cyanmycelium/mcp-core/node"; // Node-only
```

Tree-shaking ensures browser bundles never pull `node:*` modules.

## Development

```sh
npm install
npm run build      # tsc -b tsconfig.build.json
npm test           # vitest run
npm run lint
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
