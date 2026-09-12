import type { ChatRequest, ChatProvider, ChatResponse, ConnectivityResult } from "../provider.js";
import { ProviderError } from "../provider.js";
import { createSecretRedactor } from "../redact.js";

export interface OpenAICompatOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Timeout for non-streaming requests in ms (0 disables). Default 60000. */
  timeoutMs?: number;
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
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_CHARS = 300;

/**
 * Provider for any OpenAI-compatible chat completions endpoint
 * (OpenAI, Azure OpenAI, vLLM, Ollama's OpenAI shim, …).
 *
 * Robustness rules: every upstream failure becomes a ProviderError with a
 * redacted, truncated message; malformed JSON/SSE never crashes the process;
 * unknown fields are ignored; aborts are honored.
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly name = "openai-compat";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #redact: (text: string) => string;

  constructor(options: OpenAICompatOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#redact = createSecretRedactor(options.apiKey);
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.#postChatCompletions(
      {
        model: this.model,
        messages: request.messages,
        stream: false,
      },
      request.signal,
      this.#timeoutMs > 0 ? AbortSignal.timeout(this.#timeoutMs) : undefined,
    );

    this.#assertContentType(response, "json");
    const body = await response.json().catch((error: unknown) => {
      throw this.#fail(`Provider returned malformed JSON: ${errorText(error)}`);
    });

    const content = (body as ChatCompletionChunk).choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw this.#fail("Provider response did not contain an assistant message");
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
      undefined,
    );

    this.#assertContentType(response, "event-stream");
    const body = response.body;
    if (!(body instanceof ReadableStream)) {
      throw this.#fail("Streaming response did not include a body stream");
    }

    for await (const event of sseEvents(body)) {
      const payload = event.data.trim();
      if (payload.length === 0) continue;
      if (payload === "[DONE]") return;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        throw this.#fail("Provider sent a malformed SSE data payload");
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield delta;
      }
      // Missing choices/delta fields are tolerated: the event carries nothing.
    }
  }

  async checkConnectivity(signal?: AbortSignal): Promise<ConnectivityResult> {
    const startedAt = Date.now();
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#apiKey}` },
        signal: this.#combineSignals(signal, undefined),
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        return {
          state: "ok",
          latencyMs,
          detail: `${response.status} from ${this.#baseUrl}/models`,
        };
      }
      const detail =
        response.status === 401 || response.status === 403
          ? "authentication was rejected (check OPENAI_API_KEY)"
          : `upstream responded with HTTP ${response.status}`;
      return { state: "unreachable", latencyMs, detail };
    } catch (error) {
      return {
        state: "unreachable",
        latencyMs: Date.now() - startedAt,
        detail: `could not reach ${this.#baseUrl}: ${this.#redact(errorText(error))}`,
      };
    }
  }

  async #postChatCompletions(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal | undefined,
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
        signal: this.#combineSignals(signal, timeoutSignal),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw this.#fail("Request aborted", 499);
      }
      if (timeoutSignal?.aborted) {
        throw this.#fail(`Provider request timed out after ${this.#timeoutMs}ms`);
      }
      throw this.#fail(`Failed to reach provider at ${this.#baseUrl}: ${errorText(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw this.#fail(
        `Provider returned ${response.status}: ${truncate(detail, MAX_ERROR_BODY_CHARS)}`,
        response.status,
      );
    }
    return response;
  }

  #combineSignals(
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal | undefined,
  ): AbortSignal | null {
    const signals = [signal, timeoutSignal].filter((s): s is AbortSignal => s !== undefined);
    const first = signals[0];
    if (first === undefined) return null;
    if (signals.length === 1) return first;
    return AbortSignal.any(signals);
  }

  #assertContentType(response: Response, expectedFragment: string): void {
    const contentType = response.headers.get("content-type");
    if (contentType !== null && !contentType.toLowerCase().includes(expectedFragment)) {
      throw this.#fail(
        `Unexpected provider content type "${contentType}" (expected ${expectedFragment})`,
      );
    }
  }

  /** Wraps provider failures with secret redaction applied. */
  #fail(message: string, status?: number): ProviderError {
    return new ProviderError(this.#redact(message), status);
  }
}

/**
 * Proper SSE event parsing: events are separated by blank lines, comment
 * lines (":…") are ignored, and multiple `data:` lines of one event are
 * joined with newlines per the SSE specification.
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<{
  data: string;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = (): { data: string } | null => {
    if (dataLines.length === 0) return null;
    const data = dataLines.join("\n");
    dataLines = [];
    return { data };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        // Blank line = event boundary; comment lines (":…") are ignored.
        if (line.length === 0) {
          const event = flush();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).replace(/^ /, ""));
        }
        // "event:", "id:", "retry:" fields are irrelevant to us.
      }
    }
    buffer += decoder.decode();
    const rest = buffer.replace(/\r$/, "");
    if (rest.length > 0 && rest.startsWith("data:")) {
      dataLines.push(rest.slice("data:".length).replace(/^ /, ""));
    }
    const finalEvent = flush();
    if (finalEvent) yield finalEvent;
  } finally {
    reader.releaseLock();
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
