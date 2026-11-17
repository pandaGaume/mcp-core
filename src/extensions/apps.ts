import type { McpClientCapabilities, McpResource, McpResourceContent, McpTool } from "../interfaces/mcp.core.interfaces";
import type { IMcpServerExtension } from "../interfaces/mcp.extension.interfaces";
import type { IMcpRequestContext } from "../interfaces/mcp.behavior.interfaces";
import { MCP_APPS_EXTENSION, MCP_APP_MIME_TYPE, MCP_UI_SCHEME } from "../interfaces/mcp.apps.interfaces";
import type { McpUiResourceMeta, McpUiToolMeta, McpUiVisibility } from "../interfaces/mcp.apps.interfaces";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws unless `uri` is a `ui://` URI, the scheme the spec reserves for UI resources. */
export function assertUiUri(uri: string): void {
    if (!uri.startsWith(MCP_UI_SCHEME) || uri.length === MCP_UI_SCHEME.length) {
        throw new Error(`MCP Apps: "${uri}" is not a ui:// resource URI`);
    }
}

/**
 * Returns `tool` with `_meta.ui` set. The tool is not modified.
 *
 * @example
 * ```ts
 * const faceplate = withUi(readValveTool, { resourceUri: "ui://scada/valve-faceplate" });
 * const appOnly = withUi(nudgeTool, { visibility: ["app"] });
 * ```
 */
export function withUi(tool: McpTool, ui: McpUiToolMeta): McpTool {
    if (ui.resourceUri !== undefined) assertUiUri(ui.resourceUri);
    return { ...tool, _meta: { ...(tool._meta ?? {}), ui: { ...ui } } };
}

/** The `_meta.ui` of a tool, `undefined` when it has none. */
export function uiOf(tool: Pick<McpTool, "_meta">): McpUiToolMeta | undefined {
    const value = tool._meta?.["ui"];
    return isObject(value) ? (value as McpUiToolMeta) : undefined;
}

/** The tool's visibility, `["model", "app"]` when it does not say. */
export function uiVisibilityOf(tool: Pick<McpTool, "_meta">): readonly McpUiVisibility[] {
    const visibility = uiOf(tool)?.visibility;
    return Array.isArray(visibility) ? visibility : ["model", "app"];
}

/** Whether the model may see and call `tool`: its visibility includes `"model"`. */
export function isModelVisible(tool: Pick<McpTool, "_meta">): boolean {
    return uiVisibilityOf(tool).includes("model");
}

/**
 * The tool as a client that does not render MCP Apps should see it:
 * `undefined` for an app-only tool (it has no use without the app), otherwise
 * the tool without `_meta.ui`. Its `content` must still make sense on its own,
 * which the spec requires of every UI tool.
 */
export function withoutUi(tool: McpTool): McpTool | undefined {
    if (!isModelVisible(tool)) return undefined;
    if (!uiOf(tool)) return tool;
    const copy: McpTool = { ...tool };
    const meta = { ...(tool._meta ?? {}) };
    delete meta["ui"];
    if (Object.keys(meta).length > 0) copy._meta = meta;
    else delete copy._meta;
    return copy;
}

/** Whether a client's declared capabilities say it renders MCP Apps. */
export function clientRendersApps(capabilities: McpClientCapabilities | undefined): boolean {
    const settings = capabilities?.extensions?.[MCP_APPS_EXTENSION];
    return isObject(settings) && Array.isArray(settings["mimeTypes"]) && (settings["mimeTypes"] as unknown[]).includes(MCP_APP_MIME_TYPE);
}

/** The client capabilities a host sends to say it renders MCP Apps. */
export function appsClientCapabilities(): McpClientCapabilities {
    return { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } };
}

/** A `resources/list` entry for a UI resource. */
export function uiResource(uri: string, name: string, options: { description?: string; ui?: McpUiResourceMeta } = {}): McpResource {
    assertUiUri(uri);
    return {
        uri,
        name,
        mimeType: MCP_APP_MIME_TYPE,
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.ui ? { _meta: { ui: { ...options.ui } } } : {}),
    };
}

/** The `resources/read` content of a UI resource: a whole HTML5 document. */
export function uiResourceContent(uri: string, html: string, ui?: McpUiResourceMeta): McpResourceContent {
    assertUiUri(uri);
    return { uri, mimeType: MCP_APP_MIME_TYPE, text: html, ...(ui ? { _meta: { ui: { ...ui } } } : {}) };
}

/**
 * Serves MCP Apps on an {@link McpServer}.
 *
 * - Declares `io.modelcontextprotocol/ui` as `{}` (informational: the Apps
 *   spec has the host declare, not the server).
 * - For a client that does not declare it renders MCP Apps, `tools/list`
 *   drops app-only tools and strips `_meta.ui` from the others, as the spec
 *   asks a server to check client support. Pass `{ adaptToClient: false }` to
 *   list every tool as is.
 * - Registers the behaviors given, typically the one serving the `ui://` resources.
 */
export class McpAppsExtension implements IMcpServerExtension {
    readonly id = MCP_APPS_EXTENSION;
    readonly behaviors: IMcpServerExtension["behaviors"];
    private readonly _adapt: boolean;

    constructor(options: { readonly behaviors?: IMcpServerExtension["behaviors"]; readonly adaptToClient?: boolean } = {}) {
        this.behaviors = options.behaviors;
        this._adapt = options.adaptToClient ?? true;
    }

    settings(): Readonly<Record<string, unknown>> {
        return {};
    }

    presentTools(tools: readonly McpTool[], request: IMcpRequestContext): McpTool[] {
        if (!this._adapt || clientRendersApps(request.clientCapabilities)) return [...tools];
        return tools.map(withoutUi).filter((tool): tool is McpTool => tool !== undefined);
    }
}
