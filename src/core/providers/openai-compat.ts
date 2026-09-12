import type { ChatRequest, ChatProvider, ChatResponse } from "../provider.js";
import { ProviderError } from "../provider.js";

export interface OpenAICompatOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
  }>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Provider for any OpenAI-compatible chat completions endpoint
 * (OpenAI, Azure OpenAI, vLLM, Ollama's OpenAI shim, …).
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly name = "openai-compat";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.#postChatCompletions(
      {
        model: this.model,
        messages: request.messages,
        stream: false,
      },
      request.signal,
    );
    const body = (await response.json()) as ChatCompletionChunk;
    const chunks = body.choices ?? [];
    const content = chunks[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError("Provider response did not contain an assistant message");
    }
    return {
      message: { role: "assistant", content },
      model: this.model,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<string> {
    const response = await this.#postChatCompletions(
      {
        model: this.model,
        messages: request.messages,
        stream: true,
      },
      request.signal,
    );
    const body = response.body;
    if (!(body instanceof ReadableStream)) {
      throw new ProviderError("Streaming response did not include a body stream");
    }
    for await (const line of sseLines(body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        throw new ProviderError("Malformed SSE payload from provider");
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield delta;
      }
    }
  }

  async #postChatCompletions(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: signal ?? null,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ProviderError("Request aborted", 499);
      }
      throw new ProviderError(
        `Failed to reach provider at ${this.#baseUrl}: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `Provider returned ${response.status}: ${truncate(detail, 300)}`,
        response.status,
      );
    }
    return response;
  }
}

/** Splits an SSE byte stream into trimmed, non-empty lines. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) yield line;
      }
    }
    buffer += decoder.decode();
    const rest = buffer.replace(/\r$/, "");
    if (rest.length > 0) yield rest;
  } finally {
    reader.releaseLock();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
