import type { ChatRequest, ChatProvider } from "./provider.js";
import type { Conversation, ConversationSummary, Message } from "./types.js";

/** Persistence boundary for conversations. */
export interface ConversationStore {
  get(id: string): Conversation | undefined;
  list(): Conversation[];
  save(conversation: Conversation): void;
  delete(id: string): boolean;
}

/** Simple in-memory store; swap for a durable implementation later. */
export class InMemoryConversationStore implements ConversationStore {
  readonly #conversations = new Map<string, Conversation>();

  get(id: string): Conversation | undefined {
    return this.#conversations.get(id);
  }

  list(): Conversation[] {
    return [...this.#conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(conversation: Conversation): void {
    this.#conversations.set(conversation.id, conversation);
  }

  delete(id: string): boolean {
    return this.#conversations.delete(id);
  }
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`Conversation not found: ${id}`);
    this.name = "ConversationNotFoundError";
  }
}

export interface ConversationServiceOptions {
  /** Maximum number of history messages sent to the provider per request. */
  maxHistoryMessages?: number;
  /** Maximum number of messages retained per conversation (oldest are dropped). */
  maxConversationMessages?: number;
  /** Prepended as a system message on every provider call when set. */
  systemPrompt?: string;
}

export interface TurnResult {
  conversation: Conversation;
  reply: Message;
}

/**
 * Owns conversations: creation, history, and generating assistant replies
 * through a ChatProvider. The provider stays stateless — we manage history.
 *
 * Commit semantics: a turn is atomic. The user message and the reply become
 * visible/persisted together, only after the provider succeeded. A failed or
 * aborted turn leaves no trace, so clients can retry the same message safely.
 */
export class ConversationService {
  readonly #store: ConversationStore;
  readonly #provider: ChatProvider;
  readonly #maxHistoryMessages: number;
  readonly #maxConversationMessages: number;
  readonly #systemPrompt: string | undefined;

  constructor(
    store: ConversationStore,
    provider: ChatProvider,
    options: ConversationServiceOptions = {},
  ) {
    this.#store = store;
    this.#provider = provider;
    this.#maxHistoryMessages = options.maxHistoryMessages ?? 20;
    this.#maxConversationMessages = Math.max(options.maxConversationMessages ?? 200, 2);
    this.#systemPrompt = options.systemPrompt;
  }

  create(title: string | null = null): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.#store.save(conversation);
    return conversation;
  }

  get(id: string): Conversation {
    const conversation = this.#store.get(id);
    if (!conversation) {
      throw new ConversationNotFoundError(id);
    }
    return conversation;
  }

  list(): ConversationSummary[] {
    return this.#store.list().map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    }));
  }

  delete(id: string): void {
    if (!this.#store.delete(id)) {
      throw new ConversationNotFoundError(id);
    }
  }

  /**
   * Appends a user message, requests a completion, appends the assistant
   * reply, and persists both atomically on success.
   */
  async turn(
    conversationId: string,
    userContent: string,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    signal?.throwIfAborted();
    const conversation = this.get(conversationId);

    const history: Message[] = [...conversation.messages, { role: "user", content: userContent }];
    const response = await this.#provider.complete({
      messages: this.#messagesForProvider(history),
      signal,
    });

    history.push(response.message);
    this.#commit(conversation, history);
    return { conversation, reply: response.message };
  }

  /**
   * Streaming variant of {@link turn}: yields assistant deltas as they arrive.
   * Persistence happens once the stream completed successfully; aborted or
   * failed streams persist nothing.
   */
  async *streamTurn(
    conversationId: string,
    userContent: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    signal?.throwIfAborted();
    const conversation = this.get(conversationId);

    const history: Message[] = [...conversation.messages, { role: "user", content: userContent }];
    const request: ChatRequest = {
      messages: this.#messagesForProvider(history),
      signal,
    };

    let reply = "";
    for await (const delta of this.#provider.stream(request)) {
      reply += delta;
      yield delta;
    }

    if (reply.length > 0) {
      history.push({ role: "assistant", content: reply });
    }
    this.#commit(conversation, history);
  }

  /** Applies retention limits, stamps the update time, and persists. */
  #commit(conversation: Conversation, history: Message[]): void {
    conversation.messages =
      history.length > this.#maxConversationMessages
        ? history.slice(-this.#maxConversationMessages)
        : history;
    conversation.updatedAt = new Date().toISOString();
    this.#store.save(conversation);
  }

  /** History sent to the provider: optional system prompt + last N messages. */
  #messagesForProvider(history: Message[]): Message[] {
    const trimmed = history.slice(-this.#maxHistoryMessages);
    if (this.#systemPrompt === undefined) {
      return trimmed;
    }
    return [{ role: "system", content: this.#systemPrompt }, ...trimmed];
  }
}
