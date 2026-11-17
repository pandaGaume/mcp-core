/**
 * Types for MCP Apps, the `io.modelcontextprotocol/ui` extension (stable
 * revision 2026-01-26, github.com/modelcontextprotocol/ext-apps): a tool
 * points at a `ui://` HTML resource the host renders in a sandboxed iframe.
 *
 * Nothing crosses the server boundary but ordinary MCP: the host reads the
 * resource with `resources/read` and the app calls tools through the host.
 * The `ui/*` messages stay between host and iframe.
 */

/** The extension identifier, declared by the client (the host) under `capabilities.extensions`. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

/** The only MIME type of a UI resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The reserved scheme of UI resources. */
export const MCP_UI_SCHEME = "ui://";

/** Who may see and call a tool: the model, the app in the iframe, or both. */
export type McpUiVisibility = "model" | "app";

/** `Tool._meta.ui`. */
export interface McpUiToolMeta {
    /** The `ui://` resource the host renders for this tool. It must exist on the server. */
    resourceUri?: string;
    /**
     * Default `["model", "app"]`. A host keeps a tool without `"model"` out of
     * the agent's tool list, and refuses an app's call to a tool without `"app"`.
     */
    visibility?: McpUiVisibility[];
}

/** Origins the app may reach, from which the host builds its Content Security Policy. */
export interface McpUiResourceCsp {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
}

/** Browser permissions the app asks the host for. */
export interface McpUiPermissions {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
}

/** `_meta.ui` on the content of a UI resource (and, in the draft, on its `resources/list` entry). */
export interface McpUiResourceMeta {
    csp?: McpUiResourceCsp;
    permissions?: McpUiPermissions;
    /** Host-defined format. */
    domain?: string;
    /** Omitted: the host decides. */
    prefersBorder?: boolean;
}

/** What a host declares: `capabilities.extensions["io.modelcontextprotocol/ui"]`. */
export interface McpAppsClientSettings {
    /** Required. Contains {@link MCP_APP_MIME_TYPE} when the host renders MCP Apps. */
    mimeTypes: string[];
}
