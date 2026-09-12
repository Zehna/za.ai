import type { ChatRequest, ChatProvider, ChatResponse } from "../provider.js";
import type { Message } from "../types.js";

export interface MockProviderOptions {
  model?: string;
  /**
   * Exact-match scripted replies: when the last user message equals a key,
   * the mapped reply is returned instead of the default echo. Useful for
   * tests and demos that need specific answers.
   */
  scripts?: Record<string, string>;
  /** Delay in ms between streamed chunks (0 by default, keeps tests fast). */
  streamDelayMs?: number;
}

/**
 * Deterministic provider used for tests, development, and keyless demos.
 * Replies echo the user's message so behavior is fully predictable.
 */
export class MockProvider implements ChatProvider {
  readonly name = "mock";
  readonly model: string;
  readonly #scripts: Record<string, string>;
  readonly #streamDelayMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.model = options.model ?? "za-mock-1";
    this.#scripts = options.scripts ?? {};
    this.#streamDelayMs = options.streamDelayMs ?? 0;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const reply = this.#replyFor(request.messages);
    return { message: { role: "assistant", content: reply }, model: this.model };
  }

  async *stream(request: ChatRequest): AsyncIterable<string> {
    const reply = this.#replyFor(request.messages);
    // Stream in small word-boundary chunks like a real provider would.
    const chunks = reply.match(/\S+\s*/g) ?? [reply];
    for (const chunk of chunks) {
      if (this.#streamDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#streamDelayMs));
      }
      yield chunk;
    }
  }

  #replyFor(messages: Message[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      return "I did not receive a user message to respond to.";
    }
    const scripted = this.#scripts[lastUser.content];
    if (scripted !== undefined) {
      return scripted;
    }
    return `[mock] You said: "${lastUser.content}"`;
  }
}
