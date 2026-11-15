// Launches an installed Chrome headless, with a throwaway profile, and drives
// one page over the DevTools protocol. No dependency: Node 22's global
// WebSocket and fetch are enough.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = {
    win32: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    ],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

/** The Chrome to run: `$CHROME`, or the first usual install location that exists. */
export function findChrome() {
    if (process.env.CHROME) return process.env.CHROME;
    return (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
}

/**
 * Starts Chrome and attaches to its first page.
 *
 * @param {string} executable
 * @param {string[]} flags extra command-line flags
 */
export async function launchChrome(executable, flags = []) {
    if (!existsSync(executable)) throw new Error(`Chrome not found at ${executable}`);
    const profile = mkdtempSync(join(tmpdir(), "mcp-core-webmcp-"));
    const discard = () => {
        try {
            rmSync(profile, { recursive: true, force: true });
        } catch {
            // Chrome may hold a file for a moment after exit; the OS cleans tmp.
        }
    };
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...flags, "about:blank"];
    // Linux CI containers run as root, where Chrome refuses its sandbox.
    if (process.platform === "linux" && process.getuid?.() === 0) args.unshift("--no-sandbox");
    const proc = spawn(executable, args, { stdio: "ignore" });
    let spawnError;
    proc.on("error", (error) => (spawnError = error));

    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 150 && !spawnError && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    if (spawnError || !existsSync(portFile)) {
        proc.kill();
        await new Promise((r) => setTimeout(r, 300));
        discard();
        throw new Error(spawnError ? `Chrome could not start: ${spawnError.message}` : `Chrome did not open its DevTools port within 15s (${executable})`);
    }
    const [port] = readFileSync(portFile, "utf8").split("\n");
    const base = `http://127.0.0.1:${port}`;
    const page = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.type === "page");
    const version = (await (await fetch(`${base}/json/version`)).json()).Browser;

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    const consoleLines = [];
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === "Runtime.consoleAPICalled") {
            consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
        } else if (msg.method === "Runtime.exceptionThrown") {
            const details = msg.params.exceptionDetails;
            consoleLines.push(`exception: ${details.exception?.description ?? details.text}`);
        }
    };
    const send = (method, params = {}) =>
        new Promise((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    await send("Runtime.enable");
    await send("Page.enable");

    return {
        version,
        consoleLines,
        /** Navigates and waits for the load event. */
        async goto(url) {
            const loaded = new Promise((resolve) => {
                const previous = ws.onmessage;
                ws.onmessage = (event) => {
                    previous(event);
                    if (JSON.parse(event.data).method === "Page.loadEventFired") {
                        ws.onmessage = previous;
                        resolve();
                    }
                };
            });
            await send("Page.navigate", { url });
            await loaded;
        },
        /** Evaluates an expression in the page, awaiting a promise, and returns its value. */
        async evaluate(expression) {
            const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
            const details = r.result?.exceptionDetails;
            if (details) throw new Error(details.exception?.description ?? details.text);
            return r.result?.result?.value;
        },
        async close() {
            ws.close();
            proc.kill();
            await new Promise((r) => setTimeout(r, 500));
            discard();
        },
    };
}
