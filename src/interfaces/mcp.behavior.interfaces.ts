import { IEventSource } from "./eventSource";
import { McpResource, McpResourceContent, McpResourceTemplate, McpTool } from "./mcp.core.interfaces";

// ── Tool Support ─────────────────────────────────────────────────────────────

/**
 * Declares how well an adapter supports a particular tool.
 *
 * Used at two levels:
 * - **Design-time** — the behavior's `getTools()` filters out `Planned` / `None`
 *   tools so they are never advertised to MCP clients.
 * - **Runtime** — `executeToolAsync` can query per-resource-type support to
 *   return descriptive errors (e.g. "orbit is not supported on GeodeticCamera").
 */
export enum ToolSupport {
    /** The adapter fully implements this tool for all resource types. */
    Full = "full",
    /** The adapter implements the tool but with limitations (documented in JSDoc). */
    Partial = "partial",
    /** The tool is recognised but not yet implemented — hidden from clients. */
    Planned = "planned",
    /** The adapter does not and will not support this tool — hidden from clients. */
    None = "none",
}

// ── Tool Result ──────────────────────────────────────────────────────────────

export interface McpToolResult {
    content: McpToolResultContent[];
    isError?: boolean;
}

export type McpToolResultContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string } // base64
    | { type: "resource"; resource: McpResourceContent }; // embedded resource

/**
 * Shared runtime contract for both behaviors and adapters.
 *
 * This interface represents operations that require a live object to execute —
 * reading the current state of a resource, and executing a tool against it.
 *
 * Both {@link IMcpBehaviorAdapter} and {@link IMcpBehavior} extend this contract:
 * - The adapter fulfills it at the BJS/data-source level (raw object access)
 * - The behavior fulfills it at the MCP protocol level (delegates to its adapter)
 *
 * This shared base ensures the server can treat behaviors and adapters
 * symmetrically when routing `resources/read` and `tools/call` requests.
 */
export interface IMcpRuntimeOperations {
    /**
     * Returns the current state of the resource identified by {@link uri},
     * serialized as MCP-compatible content.
     * Returns `undefined` if the URI is not handled by this instance.
     */
    readResourceAsync(uri: string): Promise<McpResourceContent | undefined>;

    /**
     * Executes a tool against the object identified by {@link uri}.
     *
     * @param toolName - Namespaced tool name e.g. `"light.dim"`
     * @param uri      - Resource URI identifying the target object e.g. `"light://scene/sun"`
     * @param args     - Tool arguments as defined in the tool's `inputSchema`
     */
    executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

/**
 * Operations knowable at design time — pure schema, no live object required.
 */
export interface IMcpDesignOperations {
    /**
     * The behavior's own resource identity — who it is in the MCP resource list.
     * This is static metadata describing the behavior category itself,
     * NOT an enumeration of backed objects.
     *
     * @example LightBehavior returns:
     * { uri: "light://scene", name: "Scene Lights", mimeType: "application/json" }
     */
    getResources(): McpResource[];

    /**
     * RFC 6570 URI templates advertised via `resources/templates/list`.
     * @example `["light://scene/{lightName}"]`
     */
    getResourceTemplates(): McpResourceTemplate[];

    /**
     * Tool schemas — static definitions, execution handled at runtime.
     */
    getTools(): McpTool[];
}

/**
 * Adapter — only layer touching BJS/data source directly.
 * Purely runtime — no identity, no schema.
 */
export interface IMcpBehaviorAdapter extends IMcpRuntimeOperations {
    onResourceContentChanged: IEventSource<string>;
    onResourcesChanged: IEventSource<void>;
    domain: string;

    /**
     * Returns the support level for a tool, optionally scoped to a resource type.
     *
     * **Design-time** (no `resourceType`): called by the behavior's `getTools()`
     * to decide whether the tool should appear in the advertised list.
     * `Full` / `Partial` → exposed; `Planned` / `None` → hidden.
     *
     * **Runtime** (`resourceType` provided): called by `executeToolAsync` to
     * check if a specific resource instance supports the tool.
     * Enables adapters to express per-type constraints, e.g.
     * "orbit is Full for ArcRotateCamera but None for a fixed camera" or
     * "geographic tools are Full for GeodeticCamera only".
     *
     * @param toolName     The tool name, e.g. `"camera_orbit"`.
     * @param resourceType Optional resource type string chosen by the adapter
     *                     (e.g. `"ArcRotateCamera"`, `"GeodeticCamera"`).
     * @returns A {@link ToolSupport} level, or `undefined` to indicate
     *          {@link ToolSupport.Full} (backwards-compatible default).
     */
    getToolSupport?(toolName: string, resourceType?: string): ToolSupport | undefined;
}

/**
 * Defines the MCP identity, schema, and protocol shape for a category of objects.
 *
 * A behavior is the MCP-facing description of "what something is and what you can do with it".
 * It owns:
 * - The namespace and URI template (identity)
 * - The tool schemas (capabilities)
 * - Runtime delegation to its adapter (data + mutations)
 *
 * A behavior is decoupled from any specific object instance — it may represent
 * a single light, all lights in a scene, or lights from a remote repository.
 * That cardinality is entirely determined by the injected {@link IMcpBehaviorAdapter}.
 *
 * Lifecycle:
 * - Registered at design time via {@link IMcpServerBuilder.withBehavior}
 * - Or registered at runtime via {@link IMcpServer.addBehavior}
 *
 * @example
 * ```typescript
 * const behavior = McpBehaviorBuilder.create("light")
 *     .withName("Scene Light")
 *     .withUriTemplate("light://scene/{lightName}")
 *     .withDescription("Controls lights in the host application's scene")
 *     .withMimeType("application/json")
 *     .withTools([dimTool, setColorTool, setEnabledTool])
 *     .withAdapter(new SceneLightsAdapter(scene))
 *     .build()
 * ```
 */
export interface IMcpBehavior extends IMcpRuntimeOperations, IMcpDesignOperations {
    /**
     * Unique namespace for this behavior's tools.
     * Prefixed to all tool names to avoid collisions across behaviors.
     * e.g. `"light"` → tools named `"light.dim"`, `"light.setColor"`.
     *
     * Must be lowercase, alphanumeric, no spaces.
     */
    readonly namespace: string;

    /** Human-readable name for this behavior category, used in template listings. */
    readonly name?: string;

    /**
     * RFC 6570 URI template describing the resource URIs produced by this behavior.
     * Advertised via `resources/templates/list` so clients can discover the URI
     * scheme without enumerating every instance.
     *
     * @example `"light://scene/{lightName}"`
     * @example `"camera://scene/{cameraName}"`
     */
    readonly uriTemplate?: string;

    /** Human-readable description of what instances of this behavior represent. */
    readonly description?: string;

    /** MIME type of content returned by `resources/read` for instances of this behavior. */
    readonly mimeType?: string;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Fluent builder for constructing an {@link IMcpBehavior}.
 *
 * Separates the concerns of behavior definition (namespace, tools, URI template)
 * from adapter wiring (data source, mutations), making each independently
 * composable and testable.
 *
 * The adapter is injected last via {@link withAdapter}, which means the same
 * behavior definition can be reused with different adapters:
 *
 * @example Single light
 * ```typescript
 * const behavior = McpBehaviorBuilder.create("light")
 *     .withTools(lightTools)
 *     .withAdapter(new SingleLightAdapter(sunLight))
 *     .build()
 * ```
 *
 * @example Entire scene
 * ```typescript
 * const behavior = McpBehaviorBuilder.create("light")
 *     .withTools(lightTools)
 *     .withAdapter(new SceneLightsAdapter(scene))
 *     .build()
 * ```
 */
export interface IMcpBehaviorBuilder {
    withName(name: string): IMcpBehaviorBuilder;
    withUriTemplate(template: string): IMcpBehaviorBuilder;
    withDescription(description: string): IMcpBehaviorBuilder;
    withMimeType(mimeType: string): IMcpBehaviorBuilder;

    /**
     * Registers the tool schemas exposed by this behavior.
     * Tool names must be prefixed with the namespace passed to {@link McpBehaviorBuilder.create}.
     */
    withTools(tools: McpTool[]): IMcpBehaviorBuilder;

    /**
     * Injects the adapter that backs this behavior.
     * The adapter is the only component with direct access to the underlying
     * data source (BJS objects, repository, remote API, etc.).
     */
    withAdapter(adapter: IMcpBehaviorAdapter): IMcpBehaviorBuilder;

    /**
     * Finalizes and returns the configured {@link IMcpBehavior}.
     * @throws if `namespace` or `adapter` have not been provided.
     */
    build(): IMcpBehavior;
}
