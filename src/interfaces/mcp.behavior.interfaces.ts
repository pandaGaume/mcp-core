import { IEventSource } from "./eventSource";
import type { McpGrammar } from "../mcp.grammar";
import { McpAnnotations, McpBaseMetadata, McpIcon, McpMeta, McpResource, McpResourceContent, McpResourceTemplate, McpTool } from "./mcp.core.interfaces";

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
    /**
     * Structured result data (MCP 2025-06-18). When set, clients receive the
     * payload as a real object instead of having to re-parse a JSON `text`
     * block. The same data should also appear serialized in {@link content}
     * for backward compatibility with clients that predate structured content.
     *
     * Declare {@link McpTool.outputSchema} alongside it so clients know the
     * shape and can validate what they receive.
     */
    structuredContent?: { [key: string]: unknown };
    isError?: boolean;

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/** Fields every content block accepts, whatever its type. */
export interface McpContentBlockBase {
    /** Display hints: intended audience, priority, last modification. */
    annotations?: McpAnnotations;

    /** Application-defined metadata. */
    _meta?: McpMeta;
}

/** Plain text. */
export interface McpTextContent extends McpContentBlockBase {
    type: "text";
    text: string;
}

/** Base64-encoded image. */
export interface McpImageContent extends McpContentBlockBase {
    type: "image";
    data: string;
    mimeType: string;
}

/** Base64-encoded audio. */
export interface McpAudioContent extends McpContentBlockBase {
    type: "audio";
    data: string;
    mimeType: string;
}

/**
 * A pointer to a resource rather than its content.
 *
 * Lets a tool hand back something large or live without inlining it. The client
 * reads or subscribes to the URI when it actually needs the data. Such a link
 * is not guaranteed to appear in `resources/list`.
 */
export interface McpResourceLinkContent extends McpContentBlockBase, McpBaseMetadata {
    type: "resource_link";
    uri: string;
    description?: string;
    mimeType?: string;
    icons?: McpIcon[];
}

/** A resource inlined in the result, sparing the client a `resources/read`. */
export interface McpEmbeddedResourceContent extends McpContentBlockBase {
    type: "resource";
    resource: McpResourceContent;
}

export type McpToolResultContent = McpTextContent | McpImageContent | McpAudioContent | McpResourceLinkContent | McpEmbeddedResourceContent;

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

    /**
     * Returns the adapter-owned grammar layer for the given key, or
     * `undefined` when the adapter does not ship overrides for that key.
     *
     * The adapter layer sits ABOVE the behavior baseline and BELOW the
     * server's static `withGrammar()` registrations and runtime store.
     * Use this when an engine binding (Babylon vs Cesium, ONNX-runtime vs
     * MCU, etc.) needs to nudge a tool or property description without
     * touching the behavior code.
     *
     * Keys are opaque strings produced by the application's
     * {@link McpGrammarResolver} (e.g. `"en"`, `"claude:fr"`, `"v2:en"`).
     * Implementations are expected to be O(1) on cached storage: the
     * server reads this once per behavior per session at `initialize()`.
     */
    getGrammar?(key: string): McpGrammar | undefined;
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

    /**
     * Returns the behavior-owned grammar baseline for the given key, or
     * `undefined` when the behavior does not ship a baseline for that key.
     *
     * "Key" is an opaque string the application's {@link McpGrammarResolver}
     * produces from the connecting client identity (typical conventions:
     * `"en"`, `"fr-CA"`, `"claude:fr"`, `"spk-v2:en"`). A behavior decides
     * which keys it supports by populating its grammars at construction.
     *
     * The behavior layer is the LOWEST priority in the four-layer stack the
     * server merges at `initialize()` time: `behavior → adapter → static →
     * store`. Implementations are expected to be O(1) on cached storage.
     */
    getGrammar?(key: string): McpGrammar | undefined;

    /**
     * Lists every grammar key the behavior knows. Used by introspection
     * tools (e.g. `McpGrammarBehavior.grammar_list`) and by application
     * code that wants to negotiate a supported key with the client.
     */
    listGrammarKeys?(): ReadonlyArray<string>;

    /**
     * Fires when the behavior's grammar map changes (e.g. hot-reload from
     * disk, runtime mutation). The server subscribes to this so it can
     * re-merge the session grammar for the current key and emit
     * `notifications/tools/list_changed`.
     */
    onGrammarsChanged?: IEventSource<void>;
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
