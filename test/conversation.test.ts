import { describe, expect, it } from "vitest";
import {
  ConversationService,
  ConversationNotFoundError,
  InMemoryConversationStore,
} from "../src/core/conversation.js";
import { MockProvider } from "../src/core/providers/mock.js";

function makeService(options: { maxHistoryMessages?: number; systemPrompt?: string } = {}) {
  const store = new InMemoryConversationStore();
  const provider = new MockProvider({ scripts: { ping: "pong" } });
  const service = new ConversationService(store, provider, options);
  return { store, provider, service };
}

describe("ConversationService", () => {
  it("creates, lists, gets, and deletes conversations", () => {
    const { service } = makeService();
    const created = service.create("My chat");
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.title).toBe("My chat");
    expect(created.messages).toEqual([]);

    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]).toMatchObject({ id: created.id, messageCount: 0 });
    expect(service.get(created.id).id).toBe(created.id);

    service.delete(created.id);
    expect(service.list()).toHaveLength(0);
    expect(() => service.get(created.id)).toThrow(ConversationNotFoundError);
    expect(() => service.delete(created.id)).toThrow(ConversationNotFoundError);
  });

  it("turn() persists the user message and the assistant reply", async () => {
    const { service } = makeService();
    const conversation = service.create();

    const { conversation: updated, reply } = await service.turn(conversation.id, "ping");
    expect(reply).toEqual({ role: "assistant", content: "pong" });
    expect(updated.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ]);
    // persisted
    expect(service.get(conversation.id).messages).toHaveLength(2);
  });

  it("streamTurn() yields deltas and persists the joined reply", async () => {
    const { service } = makeService();
    const conversation = service.create();

    const deltas: string[] = [];
    for await (const delta of service.streamTurn(conversation.id, "hello world")) {
      deltas.push(delta);
    }
    expect(deltas.join("")).toBe('[mock] You said: "hello world"');
    const persisted = service.get(conversation.id);
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages[1]).toEqual({
      role: "assistant",
      content: '[mock] You said: "hello world"',
    });
  });

  it("sends only the last maxHistoryMessages plus the system prompt", async () => {
    let captured: { messages: Array<{ role: string; content: string }> } | undefined;
    const store = new InMemoryConversationStore();
    const fakeProvider = {
      name: "spy",
      model: "spy-1",
      async complete(request: { messages: Array<{ role: string; content: string }> }) {
        captured = request;
        return { message: { role: "assistant" as const, content: "ok" }, model: "spy-1" };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("not used");
      },
    };
    const service = new ConversationService(store, fakeProvider, {
      maxHistoryMessages: 4,
      systemPrompt: "You are za.ai.",
    });

    const conversation = service.create();
    for (let i = 0; i < 10; i++) {
      await service.turn(conversation.id, `message ${i}`);
    }

    expect(captured).toBeDefined();
    const sent = captured!.messages;
    // The provider call happens before the current turn's reply is appended,
    // so history ends with the user message of turn 9 and reply of turn 8.
    expect(sent).toHaveLength(5);
    expect(sent[0]).toEqual({ role: "system", content: "You are za.ai." });
    expect(sent.slice(1).map((m) => m.content)).toEqual(["ok", "message 8", "ok", "message 9"]);
  });

  it("rejects turns on unknown conversations", async () => {
    const { service } = makeService();
    await expect(service.turn("nope", "hi")).rejects.toThrow(ConversationNotFoundError);
    await expect(async () => {
      for await (const _ of service.streamTurn("nope", "hi")) {
        // consume
      }
    }).rejects.toThrow(ConversationNotFoundError);
  });
});
