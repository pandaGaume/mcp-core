import type { McpTool, McpToolAnnotations, McpToolResult } from "../interfaces";
import { McpToolResults } from "../mcp.toolResult";
import type { WebMcpRegisteredTool, WebMcpToolAnnotations } from "./webmcp.types";

/** `_meta` key under which a re-served WebMCP tool keeps what MCP has no field for. */
export const WEBMCP_META_KEY = "io.cyanmycelium/webmcp";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Whether `name` is a tool name WebMCP accepts (and MCP 2025-11-25 too). */
export function isWebMcpToolName(name: string): boolean {
    return TOOL_NAME.test(name);
}

/**
 * MCP hints to WebMCP hints.
 *
 * - `readOnlyHint` maps to itself.
 * - `destructiveHint` on a tool that is not read-only becomes
 *   `consequentialHint`: both mean "ask before doing this".
 * - `openWorldHint` becomes `untrustedContentHint`: a tool reaching the open
 *   world returns content the server does not vouch for.
 *
 * Returns `undefined` when nothing maps, so the definition stays minimal.
 */
export function toWebMcpAnnotations(annotations: McpToolAnnotations | undefined): WebMcpToolAnnotations | undefined {
    if (!annotations) return undefined;
    const out: WebMcpToolAnnotations = {};
    if (annotations.readOnlyHint) out.readOnlyHint = true;
    if (annotations.destructiveHint && !annotations.readOnlyHint) out.consequentialHint = true;
    if (annotations.openWorldHint) out.untrustedContentHint = true;
    return Object.keys(out).length > 0 ? out : undefined;
}

/** WebMCP hints to MCP hints, the reverse of {@link toWebMcpAnnotations}. `debugging` has no MCP equivalent. */
export function fromWebMcpAnnotations(annotations: WebMcpToolAnnotations | undefined, title?: string): McpToolAnnotations | undefined {
    const out: McpToolAnnotations = {};
    if (title) out.title = title;
    if (annotations?.readOnlyHint) out.readOnlyHint = true;
    if (annotations?.consequentialHint && !annotations.readOnlyHint) out.destructiveHint = true;
    if (annotations?.untrustedContentHint) out.openWorldHint = true;
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The value a WebMCP `execute` callback resolves with, for one MCP result.
 *
 * - A successful result carrying `structuredContent` gives that object: it is
 *   what the tool's `outputSchema` describes.
 * - Anything else gives the MCP result itself (`content`, `isError`). A
 *   failure in particular is returned, never thrown: WebMCP hands a rejected
 *   callback to the caller as a bare `OperationError` without its message,
 *   so the agent could not read the error and retry.
 */
export function toWebMcpResult(result: McpToolResult): unknown {
    if (!result.isError && result.structuredContent) return result.structuredContent;
    const out: Record<string, unknown> = { content: result.content ?? [] };
    if (result.isError) out.isError = true;
    if (result.structuredContent) out.structuredContent = result.structuredContent;
    return out;
}

/**
 * One MCP result from what `executeTool` resolved with (a JSON string).
 *
 * - A value shaped like an MCP result (a `content` array) passes through, so a
 *   tool published by a {@link WebMcpExporter} round-trips unchanged.
 * - A plain object becomes a JSON text block plus `structuredContent`.
 * - Anything else becomes its JSON text.
 */
export function fromWebMcpResult(serialized: string): McpToolResult {
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    } catch {
        return McpToolResults.text(serialized);
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)) {
        return value as McpToolResult;
    }
    if (typeof value === "string") return McpToolResults.text(value);
    return McpToolResults.json(value);
}

/** An MCP tool describing one tool a page registered with WebMCP. */
export function fromWebMcpTool(tool: WebMcpRegisteredTool): McpTool {
    const out: McpTool = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object" },
        _meta: { [WEBMCP_META_KEY]: { origin: tool.origin, ...(tool.annotations ? { annotations: tool.annotations } : {}) } },
    };
    if (tool.title) out.title = tool.title;
    if (tool.outputSchema) out.outputSchema = tool.outputSchema;
    const annotations = fromWebMcpAnnotations(tool.annotations, tool.title);
    if (annotations) out.annotations = annotations;
    return out;
}
