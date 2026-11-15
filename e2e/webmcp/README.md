# WebMCP in a real browser

`tests/webmcp.test.ts` checks `@cyanmycelium/mcp-core/web` against a fake
`document.modelContext` written from the draft. This directory runs the same
bridges against a browser's own implementation, so a difference between the
draft and what a browser ships shows up here.

```sh
npm run test:browser          # builds, then runs
node e2e/webmcp/run.mjs       # runs against the existing dist/
```

## What it needs

- Node 22 or later (global `WebSocket` for the DevTools protocol; nothing to install).
- Chrome 146 or later. It is found at its usual install location on Windows,
  macOS and Linux; set `CHROME` to point at another executable.

The runner starts Chrome headless with a throwaway profile and
`--enable-features=WebMCP` (the feature behind `chrome://flags/#enable-webmcp-testing`),
serves `page.html` and `dist/` on `localhost`, which is a secure context, and
reads the results over the DevTools protocol. Your own Chrome profile is never
touched.

## What it checks

`page.html` runs every scenario inside the page and returns one check each:

| area                               | checks                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebMcpExporter`                   | tools land in the browser's registry with title, schema and origin; hints mapped (`destructiveHint` to `consequentialHint`, `readOnlyHint` kept); an invalid name is reported, not published; the registry refuses a duplicate name         |
| results                            | `structuredContent` comes back serialized by the browser; a tool error comes back readable (`isError`), not as an opaque rejection                                                                                                          |
| live lists                         | a behavior registered or unregistered on the server appears in and leaves the registry (`toolchange` fires); `stop()` unregisters everything                                                                                                |
| `WebMcpAdapter` + `WebMcpBehavior` | the page's own tools are served over MCP through `executeTool`; hints and origin come back; a failing page tool becomes `isError` without leaking its reason; a tool registered later, or aborted, reaches the MCP client as `list_changed` |
| cancellation                       | the browser's `executeTool` signal aborts the server request; an MCP client's abort aborts the page tool's signal                                                                                                                           |

Lines marked `NOTE` describe the browser, not mcp-core. Chrome 157, for
instance, drops `outputSchema`: the exporter hands it to `registerTool` (a
check), but `getTools()` does not return it (a note).

Exit code `0` when every check passed, `1` when one failed, `2` when the run
could not start (no Chrome, no WebMCP, no `dist/`).

## Not covered

- A real browser agent calling the tools: none runs headless.
- Cross-origin tools (`exposedTo`, `fromOrigins`, `allow="tools"` iframes).
