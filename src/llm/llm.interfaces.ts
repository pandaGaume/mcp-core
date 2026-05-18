// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** Role in a chat conversation. */
export type LlmRole = "system" | "user" | "assistant";

/** A single message in a chat conversation. */
export interface LlmMessage {
    role: LlmRole;
    content: string;
}

// ---------------------------------------------------------------------------
// Request configuration
// ---------------------------------------------------------------------------

/** Per-request options that override the client defaults. */
export interface LlmRequestOptions {
    /** Model identifier (overrides client default). */
    model?: string;
    /** Sampling temperature 0..2. */
    temperature?: number;
    /** Maximum tokens to generate. */
    maxTokens?: number;
    /** Stop sequences. */
    stop?: string[];
    /** Additional vendor-specific parameters forwarded as-is to the API. */
    extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

/** Token usage statistics returned by the API. */
export interface LlmUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/** Complete (non-streaming) chat completion response. */
export interface LlmCompletion {
    /** API-assigned completion ID. */
    id: string;
    /** Model that generated the response. */
    model: string;
    /** Generated text content. */
    content: string;
    /** Why generation stopped (e.g. "stop", "length"). */
    finishReason: string;
    /** Token usage statistics (when provided by the API). */
    usage?: LlmUsage;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** A single streaming token chunk. */
export interface LlmStreamChunk {
    /** API-assigned completion ID (same across all chunks). */
    id: string;
    /** The token delta (may be empty on the first/last chunk). */
    content: string;
    /** Set on the final chunk when generation stops. */
    finishReason?: string;
}

/**
 * A streaming completion result. Can be consumed as an async iterable
 * (token-by-token) or collected into a full string via {@link text}.
 */
export interface LlmStreamResult {
    /** Async iterator yielding token deltas. */
    [Symbol.asyncIterator](): AsyncIterableIterator<LlmStreamChunk>;
    /** Convenience: collects all chunks and returns the full response text. */
    text(): Promise<string>;
    /** Aborts the in-flight stream. */
    abort(): void;
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Configuration for {@link LlmClient}. */
export interface LlmClientConfig {
    /**
     * Base URL of the OpenAI-compatible API (no trailing slash).
     * Examples: `"https://api.openai.com"`, `"http://localhost:8000"`, `"http://localhost:11434"`
     */
    baseUrl: string;
    /** Default model name sent with every request. Can be overridden per-request. */
    model: string;
    /** Optional API key. Sent as `Authorization: Bearer <key>`. */
    apiKey?: string;
    /** Default request parameters applied to every call (overridable per-request). */
    defaults?: LlmRequestOptions;
    /** Request timeout in milliseconds. @default 60_000 */
    timeoutMs?: number;
}
