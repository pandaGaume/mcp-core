import { McpResourceContent, McpToolResult } from "./interfaces";

/**
 * Factory helpers for constructing {@link McpToolResult} responses.
 *
 * Keeps tool implementations clean — return a result without manually
 * building the content array each time.
 *
 * @example
 * ```typescript
 * return McpToolResults.text(`Dimmed sun-light to 30%`)
 * return McpToolResults.json({ uri, intensity: 0.3 })
 * return McpToolResults.resource(await this.readResource(uri))
 * return McpToolResults.error(`Light not found: ${uri}`)
 * ```
 */
export const McpToolResults = {
    /** Plain text confirmation or message. */
    text: (text: string): McpToolResult => ({ content: [{ type: "text", text }] }),

    /**
     * Serialized JSON — convenience over `text(JSON.stringify(...))`.
     *
     * Emits the payload as a JSON `text` block (backward-compatible) and, when
     * `data` is a plain object, also as `structuredContent` (MCP 2025-06-18) so
     * modern clients receive it structured without re-parsing the text block.
     * Arrays and primitives are not valid `structuredContent`, so they are
     * emitted as the `text` block only.
     */
    json: (data: unknown): McpToolResult => {
        const result: McpToolResult = { content: [{ type: "text", text: JSON.stringify(data) }] };
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            result.structuredContent = data as { [key: string]: unknown };
        }
        return result;
    },

    /** Embeds an updated resource inline — avoids a round-trip `resources/read`. */
    resource: (resource: McpResourceContent): McpToolResult => ({ content: [{ type: "resource", resource }] }),

    /** Base64 image. */
    image: (data: string, mimeType: string): McpToolResult => ({ content: [{ type: "image", data, mimeType }] }),

    /** Tool-level error — `isError: true` signals failure to the client without throwing. */
    error: (message: string): McpToolResult => ({ content: [{ type: "text", text: message }], isError: true }),
} as const;
