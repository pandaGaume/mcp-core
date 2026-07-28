import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src";
import { ChildProcessTransport } from "../src/node/childprocess.transport";

/**
 * A minimal MCP server as a one-liner, launched the way real ones are: as a
 * subprocess speaking newline-delimited JSON-RPC on its own stdio.
 */
const SERVER = `
let buf = "";
process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        const result = msg.method === "initialize"
            ? { protocolVersion: "2025-11-25", serverInfo: { name: "child", version: "1.0.0" }, capabilities: {} }
            : { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Ignores stdin closing and SIGTERM, so only escalation ends it. */
const STUBBORN = `
process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

let transport: ChildProcessTransport | undefined;

afterEach(async () => {
    transport?.close();
    await transport?.exited;
    transport = undefined;
});

function spawnScript(source: string, options: { stderr?: "ignore" | ((line: string) => void); shutdownTimeoutMs?: number } = {}): ChildProcessTransport {
    return new ChildProcessTransport({ command: process.execPath, args: ["-e", source], ...options });
}

describe("ChildProcessTransport", () => {
    it("drives a real MCP server launched as a subprocess", async () => {
        transport = spawnScript(SERVER);

        const client = new McpClient({ name: "agent", version: "1.0.0" }, transport);
        const init = await client.connect();
        expect(init.serverInfo.name).toBe("child");

        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["ping"]);
    });

    it("reassembles frames split across chunks and splits chunks holding several", async () => {
        transport = spawnScript("process.stdin.resume();");
        const received: string[] = [];
        transport.onMessage = (data) => received.push(data);

        await new Promise<void>((resolve) => {
            transport!.onOpen = () => resolve();
            transport!.connect();
        });

        // Reach into the framing directly: a pipe hands over whatever it happens
        // to have, and both halves of that must work.
        const readStdout = (transport as unknown as { _readStdout(chunk: Buffer): void })._readStdout.bind(transport);
        readStdout(Buffer.from('{"a":1}\n{"b":2}\n'));
        readStdout(Buffer.from('{"c":'));
        readStdout(Buffer.from("3}\n"));

        expect(received).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it("routes stderr to a callback without ever treating it as a message", async () => {
        const logs: string[] = [];
        transport = spawnScript(`process.stderr.write("starting up\\nready\\n"); process.stdin.resume();`, { stderr: (line) => logs.push(line) });

        const messages: string[] = [];
        transport.onMessage = (data) => messages.push(data);

        await new Promise<void>((resolve) => {
            transport!.onOpen = () => resolve();
            transport!.connect();
        });
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Servers may log anything to stderr, so none of it is protocol.
        expect(logs).toEqual(["starting up", "ready"]);
        expect(messages).toEqual([]);
    });

    it("shuts down by closing stdin, letting the server exit on its own", async () => {
        transport = spawnScript(SERVER);
        await new Promise<void>((resolve) => {
            transport!.onOpen = () => resolve();
            transport!.connect();
        });

        transport.close();
        expect(await transport.exited).toBe(0);
        expect(transport.isOpen).toBe(false);
    });

    it("escalates to a signal when the child ignores a closed stdin", async () => {
        transport = spawnScript(STUBBORN, { shutdownTimeoutMs: 150 });
        await new Promise<void>((resolve) => {
            transport!.onOpen = () => resolve();
            transport!.connect();
        });

        transport.close();
        // Nothing but escalation can end this one, and it must still end.
        await expect(transport.exited).resolves.not.toBeUndefined();
    }, 15_000);

    it("reports a command that cannot be run", async () => {
        transport = new ChildProcessTransport({ command: "definitely-not-a-real-command-xyz" });

        const error = await new Promise<Error>((resolve) => {
            transport!.onError = resolve;
            transport!.connect();
        });
        expect(error.message).toContain("cannot run");
        expect(transport.isOpen).toBe(false);
    });
});
