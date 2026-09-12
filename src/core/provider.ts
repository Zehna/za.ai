import type { Message } from "./types.js";

export interface ChatRequest {
  /** Full message history to send to the model (including system prompt if any). */
  messages: Message[];
  /** Optional abort signal propagated to the underlying transport. */
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: Message;
  model: string;
}

/**
 * A chat completion backend. Implementations must be stateless with respect to
 * history — callers own the conversation and pass the messages to send.
 */
export interface ChatProvider {
  readonly name: string;
  /** The model identifier reported back to clients. */
  readonly model: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
  /** Yields incremental text deltas of the assistant reply. */
  stream(request: ChatRequest): AsyncIterable<string>;
}

/** Thrown when a provider fails at the transport or protocol level. */
export class ProviderError extends Error {
  readonly status?: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
