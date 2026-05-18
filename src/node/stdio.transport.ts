import type { IMessageTransport } from "../interfaces";

/**
 * IMessageTransport implementation backed by Node.js stdin/stdout.
 *
 * The MCP stdio protocol is line-delimited: each JSON-RPC frame is a single
 * line on stdout, terminated by '\n'. Frames received on stdin are split on
 * the same delimiter. Diagnostics are written to stderr only, since stdout is
 * reserved for protocol traffic.
 *
 * Only one StdioTransport instance can exist per process; stdin is a global
 * resource and a second listener would split the byte stream.
 */
export class StdioTransport implements IMessageTransport {
    public onMessage: ((data: string) => void) | null = null;
    public onOpen: (() => void) | null = null;
    public onClose: (() => void) | null = null;
    public onError: ((error: Error) => void) | null = null;

    private _open = false;
    private _buffer = "";
    private _onStdinData = (chunk: Buffer | string): void => {
        this._buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let nl = this._buffer.indexOf("\n");
        while (nl !== -1) {
            const line = this._buffer.slice(0, nl).trim();
            this._buffer = this._buffer.slice(nl + 1);
            if (line.length > 0) this.onMessage?.(line);
            nl = this._buffer.indexOf("\n");
        }
    };
    private _onStdinEnd = (): void => {
        this._open = false;
        this.onClose?.();
    };
    private _onStdinError = (err: Error): void => {
        this.onError?.(err);
    };

    public get isOpen(): boolean {
        return this._open;
    }

    public connect(): void {
        if (this._open) return;
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", this._onStdinData);
        process.stdin.on("end", this._onStdinEnd);
        process.stdin.on("error", this._onStdinError);
        process.stdin.resume();
        this._open = true;
        // Notify asynchronously so the caller has time to register handlers.
        queueMicrotask(() => this.onOpen?.());
    }

    public send(data: string): void {
        if (!this._open) return;
        process.stdout.write(data + "\n");
    }

    public close(): void {
        if (!this._open) return;
        this._open = false;
        process.stdin.off("data", this._onStdinData);
        process.stdin.off("end", this._onStdinEnd);
        process.stdin.off("error", this._onStdinError);
        try {
            process.stdin.pause();
        } catch {
            /* ignore */
        }
        this.onClose?.();
    }
}
