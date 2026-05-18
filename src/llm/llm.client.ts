import type { LlmClientConfig, LlmCompletion, LlmMessage, LlmRequestOptions, LlmStreamChunk, LlmStreamResult } from "./llm.interfaces.js";

// ---------------------------------------------------------------------------
// LlmError
// ---------------------------------------------------------------------------

/** Error thrown by {@link LlmClient} on HTTP or parsing failures. */
export class LlmError extends Error {
    /** HTTP status code (when the error originated from a response). */
    readonly status?: number;
    /** Parsed or raw response body (when available). */
    readonly body?: unknown;

    constructor(message: string, status?: number, body?: unknown) {
        super(message);
        this.name = "LlmError";
        this.status = status;
        this.body = body;
    }
}

// ---------------------------------------------------------------------------
// StreamResult (private)
// ---------------------------------------------------------------------------

class StreamResult implements LlmStreamResult {
    private readonly _controller: AbortController;
    private readonly _generator: AsyncGenerator<LlmStreamChunk>;

    constructor(controller: AbortController, generator: AsyncGenerator<LlmStreamChunk>) {
        this._controller = controller;
        this._generator = generator;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<LlmStreamChunk> {
        return this._generator;
    }

    async text(): Promise<string> {
        let result = "";
        for await (const chunk of this) {
            result += chunk.content;
        }
        return result;
    }

    abort(): void {
        this._controller.abort();
    }
}

// ---------------------------------------------------------------------------
// LlmClient
// ---------------------------------------------------------------------------

/**
 * Browser-compatible client for OpenAI-compatible Chat Completion APIs.
 *
 * Works with any server that implements the `/v1/chat/completions` endpoint:
 * OpenAI, vLLM, Ollama, LiteLLM, TGI, LocalAI, etc.
 *
 * @example
 * ```typescript
 * const llm = new LlmClient({ baseUrl: "http://localhost:8000", model: "mistral-7b" });
 *
 * // Non-streaming
 * const result = await llm.complete([
 *     { role: "user", content: "Hello!" },
 * ]);
 * console.log(result.content);
 *
 * // Streaming
 * for await (const chunk of llm.stream([{ role: "user", content: "Hello!" }])) {
 *     process.stdout.write(chunk.content);
 * }
 * ```
 */
export class LlmApiClient {
    private readonly _config: LlmClientConfig;
    private readonly _timeoutMs: number;

    constructor(config: LlmClientConfig) {
        this._config = config;
        this._timeoutMs = config.timeoutMs ?? 60_000;
    }

    /** Base URL of the API. */
    get baseUrl(): string {
        return this._config.baseUrl;
    }

    /** Default model name. */
    get model(): string {
        return this._config.model;
    }

    // ── Non-streaming ────────────────────────────────────────────────────

    /**
     * Sends a non-streaming chat completion request and returns the full response.
     *
     * @param messages  Conversation history.
     * @param options   Per-request overrides.
     * @param signal    Optional caller-provided abort signal.
     */
    async complete(messages: LlmMessage[], options?: LlmRequestOptions, signal?: AbortSignal): Promise<LlmCompletion> {
        const body = this._buildRequestBody(messages, options, false);
        const combinedSignal = this._combineSignals(signal);

        const response = await this._fetch(body, combinedSignal);

        if (!response.ok) {
            await this._throwHttpError(response);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let json: any;
        try {
            json = await response.json();
        } catch {
            throw new LlmError("Failed to parse response JSON", response.status);
        }

        const choice = json.choices?.[0];
        return {
            id: json.id ?? "",
            model: json.model ?? "",
            content: choice?.message?.content ?? "",
            finishReason: choice?.finish_reason ?? "",
            usage: json.usage
                ? {
                      promptTokens: json.usage.prompt_tokens ?? 0,
                      completionTokens: json.usage.completion_tokens ?? 0,
                      totalTokens: json.usage.total_tokens ?? 0,
                  }
                : undefined,
        };
    }

    // ── Streaming ────────────────────────────────────────────────────────

    /**
     * Sends a streaming chat completion request. Returns an async iterable
     * that yields token chunks as they arrive.
     *
     * @param messages  Conversation history.
     * @param options   Per-request overrides.
     */
    stream(messages: LlmMessage[], options?: LlmRequestOptions): LlmStreamResult {
        const controller = new AbortController();
        const body = this._buildRequestBody(messages, options, true);
        const generator = this._streamGenerator(body, controller);
        return new StreamResult(controller, generator);
    }

    // ── Private helpers ──────────────────────────────────────────────────

    private _buildRequestBody(
        messages: LlmMessage[],
        options: LlmRequestOptions | undefined,
        stream: boolean
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Record<string, any> {
        const defaults = this._config.defaults ?? {};
        const model = options?.model ?? defaults.model ?? this._config.model;
        const temperature = options?.temperature ?? defaults.temperature;
        const maxTokens = options?.maxTokens ?? defaults.maxTokens;
        const stop = options?.stop ?? defaults.stop;
        const extra = { ...defaults.extra, ...options?.extra };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: Record<string, any> = { model, messages, stream };
        if (temperature !== undefined) body.temperature = temperature;
        if (maxTokens !== undefined) body.max_tokens = maxTokens;
        if (stop !== undefined) body.stop = stop;
        Object.assign(body, extra);

        return body;
    }

    private async _fetch(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
        const url = `${this._config.baseUrl}/v1/chat/completions`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this._config.apiKey) {
            headers["Authorization"] = `Bearer ${this._config.apiKey}`;
        }

        return fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });
    }

    private _combineSignals(callerSignal?: AbortSignal): AbortSignal {
        const timeoutSignal = AbortSignal.timeout(this._timeoutMs);
        if (callerSignal) {
            return AbortSignal.any([callerSignal, timeoutSignal]);
        }
        return timeoutSignal;
    }

    private async _throwHttpError(response: Response): Promise<never> {
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            try {
                body = await response.text();
            } catch {
                // ignore
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (body as any)?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
        throw new LlmError(msg, response.status, body);
    }

    private async *_streamGenerator(body: Record<string, unknown>, controller: AbortController): AsyncGenerator<LlmStreamChunk> {
        const combinedSignal = this._combineSignals(controller.signal);
        const response = await this._fetch(body, combinedSignal);

        if (!response.ok) {
            await this._throwHttpError(response);
        }

        if (!response.body) {
            throw new LlmError("Response body is not readable (streaming not supported)");
        }

        yield* this._parseSSE(response.body.getReader(), combinedSignal);
    }

    private async *_parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): AsyncGenerator<LlmStreamChunk> {
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                if (signal.aborted) return;

                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop()!; // last element is potentially incomplete

                for (const line of lines) {
                    if (signal.aborted) return;
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data:")) continue;

                    const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
                    if (payload === "[DONE]") return;

                    try {
                        const parsed = JSON.parse(payload);
                        const choice = parsed.choices?.[0];
                        yield {
                            id: parsed.id ?? "",
                            content: choice?.delta?.content ?? "",
                            finishReason: choice?.finish_reason ?? undefined,
                        };
                    } catch {
                        // Skip malformed SSE lines
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}
