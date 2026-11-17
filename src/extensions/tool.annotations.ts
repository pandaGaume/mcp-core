import type { McpTool } from "../interfaces/mcp.core.interfaces";
import type { McpContentBlockBase, McpToolResult } from "../interfaces/mcp.behavior.interfaces";
import { MCP_ACTION_METADATA_EXTENSION, MCP_TRUST_ANNOTATIONS_EXTENSION } from "../interfaces/mcp.annotations.interfaces";
import type { McpActionMetadata, McpTrustAnnotations } from "../interfaces/mcp.annotations.interfaces";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns `tool` with action metadata in its annotations, under
 * `annotations["io.modelcontextprotocol/action-metadata"]`. The tool is not
 * modified. Changing this on a published tool calls for
 * `notifications/tools/list_changed`.
 *
 * @example
 * ```ts
 * const write = withActionMetadata(setpointTool, { outcome: "irreversible", requiresReview: true });
 * ```
 */
export function withActionMetadata(tool: McpTool, metadata: McpActionMetadata): McpTool {
    return { ...tool, annotations: { ...(tool.annotations ?? {}), [MCP_ACTION_METADATA_EXTENSION]: { ...metadata } } };
}

/** The action metadata a tool carries, `undefined` when none or when it is not an object. */
export function actionMetadataOf(tool: Pick<McpTool, "annotations">): McpActionMetadata | undefined {
    const value = (tool.annotations as Record<string, unknown> | undefined)?.[MCP_ACTION_METADATA_EXTENSION];
    return isObject(value) ? (value as McpActionMetadata) : undefined;
}

/**
 * Whether a caller should ask a human before running `tool`: it says
 * `requiresReview`, or its outcome is `irreversible`. Advisory only.
 */
export function toolNeedsReview(tool: Pick<McpTool, "annotations">): boolean {
    const metadata = actionMetadataOf(tool);
    return metadata?.requiresReview === true || metadata?.outcome === "irreversible";
}

/** Returns `result` with trust annotations in its `_meta`. The result is not modified. */
export function withTrustAnnotations(result: McpToolResult, annotations: McpTrustAnnotations): McpToolResult {
    return { ...result, _meta: { ...(result._meta ?? {}), [MCP_TRUST_ANNOTATIONS_EXTENSION]: { ...annotations } } };
}

function trustOf(meta: Record<string, unknown> | undefined): McpTrustAnnotations | undefined {
    const value = meta?.[MCP_TRUST_ANNOTATIONS_EXTENSION];
    return isObject(value) ? (value as McpTrustAnnotations) : undefined;
}

/**
 * The trust annotations of a tool result, merged with those of its content
 * blocks the way the draft requires: a flag once `true` stays `true` (a block
 * cannot weaken the result), and an absent flag stays absent ("no claim").
 * The result-level `evidenceRef` wins; a block's is used only when the result
 * has none.
 */
export function trustAnnotationsOf(result: Pick<McpToolResult, "_meta" | "content">): McpTrustAnnotations | undefined {
    const layers = [trustOf(result._meta), ...(result.content ?? []).map((block) => trustOf((block as McpContentBlockBase)._meta))].filter(
        (layer): layer is McpTrustAnnotations => layer !== undefined
    );
    if (layers.length === 0) return undefined;
    const merged: McpTrustAnnotations = {};
    for (const flag of ["sensitive", "untrusted"] as const) {
        if (layers.some((layer) => layer[flag] === true)) merged[flag] = true;
        else if (layers.some((layer) => layer[flag] === false)) merged[flag] = false;
    }
    const evidence = layers.find((layer) => layer.evidenceRef !== undefined)?.evidenceRef;
    if (evidence) merged.evidenceRef = evidence;
    return merged;
}
