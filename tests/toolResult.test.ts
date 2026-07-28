import { describe, it, expect } from "vitest";
import { McpToolResults } from "../src/mcp.toolResult";

describe("McpToolResults.json, structured content (MCP 2025-06-18)", () => {
    it("emits a plain object both as a JSON text block and as structuredContent", () => {
        const data = { count: 2, providers: ["a", "b"] };
        const result = McpToolResults.json(data);

        // Backward-compatible text block.
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
        // Structured payload: the same object, not re-parsed.
        expect(result.structuredContent).toEqual(data);
    });

    it("omits structuredContent for an array payload (not a valid JSON object)", () => {
        const result = McpToolResults.json([1, 2, 3]);
        expect(result.content[0]).toEqual({ type: "text", text: "[1,2,3]" });
        expect(result.structuredContent).toBeUndefined();
    });

    it("omits structuredContent for primitive and null payloads", () => {
        expect(McpToolResults.json("hello").structuredContent).toBeUndefined();
        expect(McpToolResults.json(42).structuredContent).toBeUndefined();
        expect(McpToolResults.json(null).structuredContent).toBeUndefined();
    });

    it("text() and error() never carry structuredContent", () => {
        expect(McpToolResults.text("ok").structuredContent).toBeUndefined();
        const err = McpToolResults.error("boom");
        expect(err.structuredContent).toBeUndefined();
        expect(err.isError).toBe(true);
    });
});
