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

    /** Serialized JSON — convenience over `text(JSON.stringify(...))`. */
    json: (data: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),

    /** Embeds an updated resource inline — avoids a round-trip `resources/read`. */
    resource: (resource: McpResourceContent): McpToolResult => ({ content: [{ type: "resource", resource }] }),

    /** Base64 image. */
    image: (data: string, mimeType: string): McpToolResult => ({ content: [{ type: "image", data, mimeType }] }),

    /** Tool-level error — `isError: true` signals failure to the client without throwing. */
    error: (message: string): McpToolResult => ({ content: [{ type: "text", text: message }], isError: true }),
} as const;
