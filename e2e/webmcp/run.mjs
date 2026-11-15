// End-to-end check of `@cyanmycelium/mcp-core/web` against a real browser's
// WebMCP. Serves `page.html` and the built `dist/` on localhost (a secure
// context), runs the page's scenarios in headless Chrome with WebMCP enabled,
// and prints one line per check.
//
//   npm run test:browser        (builds first)
//   node e2e/webmcp/run.mjs     (uses the existing dist/)
//
// Exit code: 0 all passed, 1 a check failed, 2 the run could not start.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome } from "./chrome.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../../dist");
const page = readFileSync(join(here, "page.html"));

function fail(message) {
    console.error(message);
    process.exit(2);
}

if (typeof WebSocket !== "function") fail("Node 22 or later is needed (global WebSocket).");
if (!existsSync(join(dist, "web", "index.js"))) fail("dist/ is missing or stale: run `npm run build` first, or `npm run test:browser`.");
const chromePath = findChrome();
if (!chromePath) fail("No Chrome found. Install Chrome 146 or later, or point CHROME at its executable.");

const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
    }
    if (path.startsWith("/dist/")) {
        const file = normalize(join(dist, path.slice("/dist/".length)));
        if (file.startsWith(dist + sep) && existsSync(file)) {
            res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "application/json" });
            return res.end(readFileSync(file));
        }
    }
    res.writeHead(404);
    res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

// `WebMCP` is the feature behind chrome://flags/#enable-webmcp-testing.
const chrome = await launchChrome(chromePath, ["--enable-features=WebMCP"]).catch((error) => {
    server.close();
    fail(error.message);
});
try {
    await chrome.goto(`http://localhost:${server.address().port}/`);
    const surface = await chrome.evaluate("typeof document.modelContext");
    if (surface !== "object") throw new Error(`${chrome.version} exposes no document.modelContext even with --enable-features=WebMCP`);
    const { checks, notes } = await chrome.evaluate("window.runAll()");

    console.log(`${chrome.version}, WebMCP enabled\n`);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `\n      ${JSON.stringify(c.detail)}`}`);
    for (const n of notes) console.log(`NOTE  ${n}`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} passed`);
    if (failed && chrome.consoleLines.length) console.log(`console: ${chrome.consoleLines.join(" | ")}`);
    process.exitCode = failed ? 1 : 0;
} catch (error) {
    console.error(`the page failed: ${error.message}`);
    if (chrome.consoleLines.length) console.error(`console: ${chrome.consoleLines.join(" | ")}`);
    process.exitCode = 2;
} finally {
    await chrome.close();
    server.close();
}
