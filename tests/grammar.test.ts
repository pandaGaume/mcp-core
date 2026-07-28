import { describe, it, expect } from "vitest";
import { McpGrammar } from "../src/mcp.grammar";

describe("McpGrammar, tools (legacy + modern shape)", () => {
    it("loads the legacy flat shape (tools-only)", () => {
        const g = McpGrammar.fromJSON({
            counter_increment: {
                description: "Add `by` to the counter.",
                properties: { by: "How much to add." },
            },
        });

        expect(g.getToolDescription("counter_increment")).toBe("Add `by` to the counter.");
        expect(g.getPropertyDescription("counter_increment", "by")).toBe("How much to add.");
    });

    it("loads the modern shape with explicit `tools` key", () => {
        const g = McpGrammar.fromJSON({
            tools: {
                broker_info: { description: "Identity of the broker." },
            },
        });

        expect(g.getToolDescription("broker_info")).toBe("Identity of the broker.");
    });

    it("set then get round-trips a tool description", () => {
        const g = new McpGrammar();
        g.setToolDescription("foo", "first");
        g.setToolDescription("foo", "second"); // overwrite
        expect(g.getToolDescription("foo")).toBe("second");
    });
});

describe("McpGrammar, resources", () => {
    it("loads resource entries from the modern shape", () => {
        const g = McpGrammar.fromJSON({
            resources: {
                "broker://info": { name: "Broker info", description: "What this broker is." },
            },
        });

        expect(g.getResourceName("broker://info")).toBe("Broker info");
        expect(g.getResourceDescription("broker://info")).toBe("What this broker is.");
    });

    it("returns undefined for unknown URIs", () => {
        const g = new McpGrammar();
        expect(g.getResourceName("broker://nope")).toBeUndefined();
        expect(g.getResourceDescription("broker://nope")).toBeUndefined();
    });

    it("set then get round-trips name and description independently", () => {
        const g = new McpGrammar();
        g.setResourceName("broker://info", "Le broker");
        g.setResourceDescription("broker://info", "Description en français.");
        expect(g.getResourceName("broker://info")).toBe("Le broker");
        expect(g.getResourceDescription("broker://info")).toBe("Description en français.");
    });
});

describe("McpGrammar, resource templates", () => {
    it("loads template entries from the modern shape", () => {
        const g = McpGrammar.fromJSON({
            templates: {
                "broker://providers/{name}": { name: "Provider slot", description: "One slot, addressed by name." },
            },
        });

        expect(g.getResourceTemplateName("broker://providers/{name}")).toBe("Provider slot");
        expect(g.getResourceTemplateDescription("broker://providers/{name}")).toBe("One slot, addressed by name.");
    });

    it("set then get round-trips name and description independently", () => {
        const g = new McpGrammar();
        g.setResourceTemplateName("a://b/{x}", "B");
        g.setResourceTemplateDescription("a://b/{x}", "describes B");
        expect(g.getResourceTemplateName("a://b/{x}")).toBe("B");
        expect(g.getResourceTemplateDescription("a://b/{x}")).toBe("describes B");
    });
});

describe("McpGrammar, round-trip and merge", () => {
    it("toJSON emits the modern shape and round-trips via fromJSON", () => {
        const a = new McpGrammar();
        a.setToolDescription("foo", "FOO");
        a.setPropertyDescription("foo", "x", "X");
        a.setResourceName("r://a", "A");
        a.setResourceDescription("r://a", "Resource A");
        a.setResourceTemplateName("t://a/{x}", "TplA");

        const json = a.toJSON();
        expect(json).toEqual({
            tools: { foo: { description: "FOO", properties: { x: "X" } } },
            resources: { "r://a": { name: "A", description: "Resource A" } },
            templates: { "t://a/{x}": { name: "TplA" } },
        });

        const b = McpGrammar.fromJSON(json);
        expect(b.getToolDescription("foo")).toBe("FOO");
        expect(b.getPropertyDescription("foo", "x")).toBe("X");
        expect(b.getResourceName("r://a")).toBe("A");
        expect(b.getResourceDescription("r://a")).toBe("Resource A");
        expect(b.getResourceTemplateName("t://a/{x}")).toBe("TplA");
    });

    it("merge stacks entries across categories, last grammar wins per key", () => {
        const a = new McpGrammar();
        a.setToolDescription("foo", "a-foo");
        a.setResourceName("r://x", "a-x");

        const b = new McpGrammar();
        b.setToolDescription("foo", "b-foo"); // overrides
        b.setToolDescription("bar", "b-bar"); // new
        b.setResourceDescription("r://x", "b-x-description"); // adds, keeps name from a
        b.setResourceTemplateName("t://y/{i}", "TplY"); // new

        const merged = McpGrammar.merge(a, b);
        expect(merged.getToolDescription("foo")).toBe("b-foo");
        expect(merged.getToolDescription("bar")).toBe("b-bar");
        expect(merged.getResourceName("r://x")).toBe("a-x");
        expect(merged.getResourceDescription("r://x")).toBe("b-x-description");
        expect(merged.getResourceTemplateName("t://y/{i}")).toBe("TplY");
    });

    it("clone produces an independent copy", () => {
        const a = new McpGrammar();
        a.setToolDescription("foo", "FOO");
        a.setResourceName("r://a", "A");

        const b = a.clone();
        a.setToolDescription("foo", "MUTATED");
        a.setResourceName("r://a", "MUTATED-A");

        // b is unchanged
        expect(b.getToolDescription("foo")).toBe("FOO");
        expect(b.getResourceName("r://a")).toBe("A");
    });

    it("toJSON omits empty categories", () => {
        const g = new McpGrammar();
        g.setResourceName("r://only", "Only");
        const json = g.toJSON();
        expect(json.resources).toBeDefined();
        expect(json.tools).toBeUndefined();
        expect(json.templates).toBeUndefined();
    });
});
