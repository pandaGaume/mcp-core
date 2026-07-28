import { spawn, type ChildProcess } from "node:child_process";
import type { IMessageTransport } from "../interfaces";

/** How the child's `stderr` is handled. */
export type ChildProcessStderr = "inherit" | "ignore" | ((line: string) => void);

/** Options for {@link ChildProcessTransport}. */
export interface IChildProcessTransportOptions {
    /** Executable to launch: `"node"`, `"npx"`, an absolute path. */
    command: string;

    /** Arguments passed to it. */
    args?: string[];

    /**
     * Extra environment variables, merged over `process.env`.
     *
     * This is also how credentials reach a stdio server: the spec is explicit
     * that stdio implementations should take them from the environment rather
     * than run the OAuth flow, which it reserves for HTTP transports.
     */
    env?: NodeJS.ProcessEnv;

    /** Working directory for the child. */
    cwd?: string;

    /**
     * What to do with the child's `stderr`.
     *
     * Servers are explicitly allowed to log anything there, informational
     * messages included, so a line arriving on it means nothing is wrong. Pass a
     * callback to route it into your own logging.
     *
     * @default "inherit"
     */
    stderr?: ChildProcessStderr;

    /**
     * How long each stage of the shutdown sequence waits before escalating.
     * @default 5000
     */
    shutdownTimeoutMs?: number;
}

/**
 * The client end of the MCP stdio transport: launches an MCP server as a
 * subprocess and speaks JSON-RPC to it.
 *
 * The counterpart of {@link StdioTransport}, and the exact mirror of it. That
 * one binds *this* process's `stdin`/`stdout`, for a server that was itself
 * launched by someone else; this one binds *the child's*, for the side doing
 * the launching. Together they cover both roles the specification defines for
 * stdio: which is how most MCP servers in the wild are actually run, since
 * they ship as an `npx` command rather than a listening endpoint.
 *
 * ```ts
 * const transport = new ChildProcessTransport({ command: "npx", args: ["-y", "some-mcp-server"] });
 * const client = new McpClient({ name: "my-agent", version: "1.0.0" }, transport);
 * await client.connect();
 * ```
 */
export class ChildProcessTransport implements IMessageTransport {
    public onMessage: ((data: string) => void) | null = null;
    public onOpen: (() => void) | null = null;
    public onClose: (() => void) | null = null;
    public onError: ((error: Error) => void) | null = null;

    private readonly _options: IChildProcessTransportOptions;
    private _proc: ChildProcess | null = null;
    private _stdoutBuffer = "";
    private _stderrBuffer = "";
    private _open = false;
    private _closing = false;

    /** Resolves with the child's exit code once it is gone, or `null` if it was signalled. */
    public readonly exited: Promise<number | null>;
    private _resolveExited!: (code: number | null) => void;

    constructor(options: IChildProcessTransportOptions) {
        this._options = options;
        this.exited = new Promise((resolve) => {
            this._resolveExited = resolve;
        });
    }

    get isOpen(): boolean {
        return this._open;
    }

    /** The child's process id once spawned, else `undefined`. */
    get pid(): number | undefined {
        return this._proc?.pid;
    }

    /** Launches the child and wires its streams. */
    connect(): void {
        if (this._proc) return;
        const { command, args = [], env, cwd, stderr = "inherit" } = this._options;

        this._proc = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            // stdin and stdout carry the protocol; stderr is diagnostics only.
            stdio: ["pipe", "pipe", stderr === "inherit" ? "inherit" : "pipe"],
        });

        this._proc.on("error", (error: Error) => {
            this._open = false;
            this.onError?.(new Error(`ChildProcessTransport: cannot run "${command}", ${error.message}`));
        });

        this._proc.on("spawn", () => {
            this._open = true;
            this.onOpen?.();
        });

        this._proc.stdout?.on("data", (chunk: Buffer) => this._readStdout(chunk));

        if (typeof stderr === "function") {
            this._proc.stderr?.on("data", (chunk: Buffer) => this._readStderr(chunk, stderr));
        } else if (stderr === "ignore") {
            this._proc.stderr?.resume();
        }

        this._proc.on("close", (code) => {
            const wasOpen = this._open;
            this._open = false;
            this._proc = null;
            this._resolveExited(code);
            if (wasOpen) this.onClose?.();
            if (!this._closing && wasOpen) {
                this.onError?.(new Error(`ChildProcessTransport: "${command}" exited with code ${code ?? "null"}`));
            }
        });
    }

    /**
     * Writes one JSON-RPC message to the child's `stdin`.
     *
     * Messages are newline-delimited and must not contain an embedded newline,
     * which serialized JSON never does.
     */
    send(data: string): void {
        if (!this._open || !this._proc?.stdin?.writable) return;
        this._proc.stdin.write(`${data}\n`, "utf8");
    }

    /**
     * Shuts the child down the way the specification prescribes: close its input
     * so it can finish on its own, then `SIGTERM` if it lingers, then `SIGKILL`.
     *
     * Returns immediately; await {@link exited} to know when the process is
     * actually gone. Killing outright would cut a server off mid-write, which is
     * exactly what the staged sequence exists to avoid.
     */
    close(): void {
        const proc = this._proc;
        if (!proc || this._closing) return;

        this._closing = true;
        this._open = false;

        // 1. Close stdin: the documented signal for a stdio server to exit.
        proc.stdin?.end();

        const grace = this._options.shutdownTimeoutMs ?? 5_000;

        // 2. Still there? Ask politely.
        const term = setTimeout(() => proc.kill("SIGTERM"), grace);
        // 3. Still there? Stop asking.
        const kill = setTimeout(() => proc.kill("SIGKILL"), grace * 2);

        const clear = (): void => {
            clearTimeout(term);
            clearTimeout(kill);
        };
        proc.once("close", clear);

        // A pending shutdown must not hold the event loop open.
        unref(term);
        unref(kill);
    }

    // -------------------------------------------------------------------------
    // Framing
    // -------------------------------------------------------------------------

    /**
     * Reassembles newline-delimited frames.
     *
     * A chunk is whatever the pipe happened to deliver: it may hold several
     * messages, or half of one, so a frame is only emitted once its newline has
     * actually arrived.
     */
    private _readStdout(chunk: Buffer): void {
        this._stdoutBuffer += chunk.toString("utf8");

        let newline: number;
        while ((newline = this._stdoutBuffer.indexOf("\n")) !== -1) {
            const line = this._stdoutBuffer.slice(0, newline).trim();
            this._stdoutBuffer = this._stdoutBuffer.slice(newline + 1);
            if (line) this.onMessage?.(line);
        }
    }

    private _readStderr(chunk: Buffer, sink: (line: string) => void): void {
        this._stderrBuffer += chunk.toString("utf8");

        let newline: number;
        while ((newline = this._stderrBuffer.indexOf("\n")) !== -1) {
            const line = this._stderrBuffer.slice(0, newline).replace(/\r$/, "");
            this._stderrBuffer = this._stderrBuffer.slice(newline + 1);
            if (line) sink(line);
        }
    }
}

function unref(timer: ReturnType<typeof setTimeout>): void {
    (timer as unknown as { unref?: () => void }).unref?.();
}
