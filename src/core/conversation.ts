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
 */
export class ConversationService {
  readonly #store: ConversationStore;
  readonly #provider: ChatProvider;
  readonly #maxHistoryMessages: number;
  readonly #systemPrompt: string | undefined;

  constructor(
    store: ConversationStore,
    provider: ChatProvider,
    options: ConversationServiceOptions = {},
  ) {
    this.#store = store;
    this.#provider = provider;
    this.#maxHistoryMessages = options.maxHistoryMessages ?? 20;
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
   * reply, and persists both. Returns the reply alongside the conversation.
   */
  async turn(conversationId: string, userContent: string): Promise<TurnResult> {
    const conversation = this.get(conversationId);
    const userMessage: Message = { role: "user", content: userContent };
    conversation.messages.push(userMessage);
    conversation.updatedAt = new Date().toISOString();

    const request: ChatRequest = {
      messages: this.#messagesForProvider(conversation),
    };
    const response = await this.#provider.complete(request);
    conversation.messages.push(response.message);
    conversation.updatedAt = new Date().toISOString();
    this.#store.save(conversation);
    return { conversation, reply: response.message };
  }

  /**
   * Streaming variant of {@link turn}: yields assistant deltas as they arrive
   * and persists the full reply once the stream completes.
   */
  async *streamTurn(conversationId: string, userContent: string): AsyncIterable<string> {
    const conversation = this.get(conversationId);
    const userMessage: Message = { role: "user", content: userContent };
    conversation.messages.push(userMessage);
    conversation.updatedAt = new Date().toISOString();

    const request: ChatRequest = {
      messages: this.#messagesForProvider(conversation),
    };

    let reply = "";
    for await (const delta of this.#provider.stream(request)) {
      reply += delta;
      yield delta;
    }

    if (reply.length > 0) {
      conversation.messages.push({ role: "assistant", content: reply });
      conversation.updatedAt = new Date().toISOString();
      this.#store.save(conversation);
    }
  }

  /** History sent to the provider: optional system prompt + last N messages. */
  #messagesForProvider(conversation: Conversation): Message[] {
    const history = conversation.messages.slice(-this.#maxHistoryMessages);
    if (this.#systemPrompt === undefined) {
      return history;
    }
    return [{ role: "system", content: this.#systemPrompt }, ...history];
  }
}
