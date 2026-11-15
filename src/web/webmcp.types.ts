/**
 * The WebMCP surface this package relies on, declared here because no
 * standard TypeScript lib ships it yet.
 *
 * Follows the Web Machine Learning Community Group draft of 13 November 2026
 * (https://webmachinelearning.github.io/webmcp/). The API is experimental and
 * still moving: every access to `document.modelContext` in this package goes
 * through {@link getModelContext}, so a rename lands in one place.
 */

/** Hints a page attaches to a tool. All default to `false`. */
export interface WebMcpToolAnnotations {
    /** The tool does not change state. */
    readOnlyHint?: boolean;
    /** The result may carry content the page does not vouch for. */
    untrustedContentHint?: boolean;
    /** The action has consequences that may warrant the user's confirmation. */
    consequentialHint?: boolean;
    /** The tool exists for debugging only. */
    debugging?: boolean;
}

/** Second argument of a tool's `execute` callback. */
export interface WebMcpToolExecuteOptions {
    /** Aborted when the caller cancels the call. */
    signal: AbortSignal;
}

/** What a page passes to `registerTool`. */
export interface WebMcpToolDefinition {
    /** 1 to 128 characters from `A-Z a-z 0-9 _ - .`. */
    name: string;
    title?: string;
    description: string;
    inputSchema?: object;
    outputSchema?: object;
    annotations?: WebMcpToolAnnotations;
    /** Its fulfilled value is serialized with `JSON.stringify` for the caller. */
    execute(input: Record<string, unknown>, options: WebMcpToolExecuteOptions): Promise<unknown>;
}

/** Second argument of `registerTool`. */
export interface WebMcpRegisterToolOptions {
    /** Other origins allowed to see and call the tool. Must be potentially trustworthy. */
    exposedTo?: string[];
    /** Aborting it unregisters the tool. */
    signal?: AbortSignal;
}

/** A tool as `getTools` reports it. */
export interface WebMcpRegisteredTool {
    name: string;
    title?: string;
    description: string;
    inputSchema?: object;
    outputSchema?: object;
    annotations?: WebMcpToolAnnotations;
    /** Origin of the document that registered the tool. */
    origin: string;
    /** The registering window; typed loosely so this file needs no DOM lib. */
    window?: unknown;
}

/** Argument of `getTools`. */
export interface WebMcpGetToolsOptions {
    /** Other origins whose tools to include, when they exposed them to this one. */
    fromOrigins?: string[];
}

/** Third argument of `executeTool`. */
export interface WebMcpExecuteToolOptions {
    signal?: AbortSignal;
}

/**
 * `document.modelContext`. An `EventTarget` firing `toolchange` whenever a
 * tool visible to this document is registered or unregistered.
 */
export interface WebMcpModelContext {
    registerTool(tool: WebMcpToolDefinition, options?: WebMcpRegisterToolOptions): Promise<void>;
    getTools(options?: WebMcpGetToolsOptions): Promise<WebMcpRegisteredTool[]>;
    /** Resolves with the tool's result serialized as JSON. */
    executeTool(tool: WebMcpRegisteredTool, input?: object, options?: WebMcpExecuteToolOptions): Promise<string>;
    addEventListener(type: "toolchange", listener: () => void): void;
    removeEventListener(type: "toolchange", listener: () => void): void;
}

/**
 * Returns the page's `modelContext`, or `undefined` where WebMCP is not
 * available (an older browser, a flag turned off, Node, a worker).
 */
export function getModelContext(target: unknown = (globalThis as { document?: unknown }).document): WebMcpModelContext | undefined {
    if (typeof target !== "object" || target === null) return undefined;
    const context = (target as { modelContext?: unknown }).modelContext;
    if (typeof context !== "object" || context === null) return undefined;
    return typeof (context as { registerTool?: unknown }).registerTool === "function" ? (context as WebMcpModelContext) : undefined;
}
