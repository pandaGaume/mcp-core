/**
 * Types for two experimental MCP extensions that annotate tools and their
 * results, from github.com/modelcontextprotocol/experimental-ext-tool-annotations
 * (draft read at commit fecace78, 2026-08-12).
 *
 * Both drafts are skeletons: the value sets other than `outcome` are still
 * open questions upstream, so they are typed as open strings here. Treat every
 * field as advisory, like every tool annotation: a hostile server can claim
 * anything. Use them to ask a human before acting, never as a grant.
 */

/** `Tool.annotations["io.modelcontextprotocol/action-metadata"]`. */
export const MCP_ACTION_METADATA_EXTENSION = "io.modelcontextprotocol/action-metadata";

/** `CallToolResult._meta["io.modelcontextprotocol/trust-annotations"]`, and the same key on a content block. */
export const MCP_TRUST_ANNOTATIONS_EXTENSION = "io.modelcontextprotocol/trust-annotations";

/** What a tool's effect amounts to. The one closed value set of the action-metadata draft. */
export type McpActionOutcome = "benign" | "consequential" | "irreversible";

/**
 * A data classification. The draft's examples use lowercase words
 * (`personal`, `public`, `internal`, `external`, `open-world`...); the values
 * are not settled upstream, so any string is accepted.
 */
export type McpDataLabel = string;

/** Where a tool sends its input, and how sensitive that input is. */
export interface McpActionInputMetadata {
    destination?: McpDataLabel;
    sensitivity?: McpDataLabel | McpDataLabel[];
    [field: string]: unknown;
}

/** Where a tool's result comes from, and how sensitive it is. */
export interface McpActionReturnMetadata {
    source?: McpDataLabel;
    sensitivity?: McpDataLabel | McpDataLabel[];
    [field: string]: unknown;
}

/**
 * Action metadata on a tool definition. Part of the definition, so a server
 * that changes it must send `notifications/tools/list_changed`.
 */
export interface McpActionMetadata {
    inputMetadata?: McpActionInputMetadata;
    returnMetadata?: McpActionReturnMetadata;
    outcome?: McpActionOutcome;
    /** The host should obtain explicit human confirmation before calling the tool. */
    requiresReview?: boolean;
    [field: string]: unknown;
}

/** A pointer to the evidence behind a trust annotation. */
export interface McpTrustEvidenceRef {
    /** Open string: a client that does not know a type must be able to ignore it. */
    type: string;
    /** `sha256:<hex>` or another algorithm-prefixed digest. */
    digest: string;
    canonicalization: string;
    schema?: string;
    ref?: string;
    [field: string]: unknown;
}

/**
 * Trust annotations on a tool result or one of its content blocks.
 * An absent flag means "no claim", never `false`.
 */
export interface McpTrustAnnotations {
    sensitive?: boolean;
    untrusted?: boolean;
    evidenceRef?: McpTrustEvidenceRef;
    [field: string]: unknown;
}
