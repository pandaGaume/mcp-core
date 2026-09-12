import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerBuilder } from "../src";
import type { IMessageTransport } from "../src/interfaces";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A transport whose lifecycle the test drives by hand.
 *
 * `connect()` reports open synchronously on purpose: that is what a tunnelled
 * transport does when it is handed an already-live socket, and it is the shape
 * that made post-open failures invisible before the server surfaced them.
 */
class ManualTransport implements IMessageTransport {
    onMessage: ((data: string) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;
    onError: ((error: Error) => void) | null = null;

    private _open = false;

    /** When set, `connect()` fails instead of opening, exercising the pre-open path. */
    constructor(private readonly _failOnConnect?: string) {}

    get isOpen(): boolean {
        return this._open;
    }

    connect(): void {
        if (this._failOnConnect !== undefined) {
            this.onError?.(new Error(this._failOnConnect));
            return;
        }
        this._open = true;
        this.onOpen?.();
    }

    send(_data: string): void {
        // The tests here never inspect outbound traffic.
    }

    close(): void {
        this._open = false;
        this.onClose?.();
    }

    /** Raises a transport-level error the way a refused slot or a socket fault would. */
    fail(message: string): void {
        this.onError?.(new Error(message));
    }
}

/** Replaces `console.error` with a silent spy, so the fallback can be asserted without polluting the run. */
function spyOnConsoleError() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

type ConsoleErrorSpy = ReturnType<typeof spyOnConsoleError>;

let consoleError: ConsoleErrorSpy | undefined;

afterEach(() => {
    consoleError?.mockRestore();
    consoleError = undefined;
});

function silenceConsoleError(): ConsoleErrorSpy {
    consoleError = spyOnConsoleError();
    return consoleError;
}

// ---------------------------------------------------------------------------
// Post-open transport errors
// ---------------------------------------------------------------------------

describe("McpServer transport events", () => {
    it("delivers a post-open transport error to onTransportError subscribers", async () => {
        const transport = new ManualTransport();
        const server = new McpServerBuilder().withName("app").withTransport(transport).build();

        const seen: string[] = [];
        server.onTransportError?.subscribe((error) => seen.push(error.message));

        await server.start();
        expect(server.isRunning).toBe(true);

        transport.fail('broker refused slot "app", already held');
        expect(seen).toEqual(['broker refused slot "app", already held']);
    });

    it("writes to console.error when nothing is subscribed, so the failure is never silent", async () => {
        const spy = silenceConsoleError();
        const transport = new ManualTransport();
        const server = new McpServerBuilder().withName("app").withTransport(transport).build();

        await server.start();
        transport.fail("socket protocol fault");

        expect(spy).toHaveBeenCalledTimes(1);
        const message = String(spy.mock.calls[0]?.[0]);
        expect(message).toContain("socket protocol fault");
        expect(message).toContain("onTransportError");
    });

    it("does not use the console fallback while a handler is attached", async () => {
        const spy = silenceConsoleError();
        const transport = new ManualTransport();
        const server = new McpServerBuilder().withName("app").withTransport(transport).build();

        const unsubscribe = server.onTransportError?.subscribe(() => undefined);
        await server.start();
        transport.fail("first");
        expect(spy).not.toHaveBeenCalled();

        // Once the last handler leaves, the error must reach the console again.
        unsubscribe?.();
        unsubscribe?.(); // idempotent: a double release must not double-decrement
        transport.fail("second");
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("still rejects start() on a pre-open error, without emitting or logging", async () => {
        const spy = silenceConsoleError();
        const transport = new ManualTransport("connection refused");
        const server = new McpServerBuilder().withName("app").withTransport(transport).build();

        const seen: string[] = [];
        server.onTransportError?.subscribe((error) => seen.push(error.message));

        await expect(server.start()).rejects.toThrow(/transport failed to open, connection refused/);
        expect(seen).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    it("emits onDisconnected after the session state is cleared", async () => {
        const transport = new ManualTransport();
        const server = new McpServerBuilder().withName("app").withTransport(transport).build();

        const running: boolean[] = [];
        server.onDisconnected?.subscribe(() => running.push(server.isRunning));

        await server.start();
        transport.close();

        expect(running).toEqual([false]);
        expect(server.isRunning).toBe(false);
    });
});
