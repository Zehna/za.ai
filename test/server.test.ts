import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { InMemoryConversationStore, ConversationService } from "../src/core/conversation.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { ProviderError } from "../src/core/provider.js";
import type { AppConfig } from "../src/core/config.js";
import type { ChatProvider } from "../src/core/provider.js";

const mockConfig: AppConfig = {
  provider: "mock",
  model: "za-mock-1",
  host: "127.0.0.1",
  port: 0,
  maxHistoryMessages: 20,
};

function makeApp(providerOverrides: Partial<MockProviderOptionsShape> = {}) {
  const store = new InMemoryConversationStore();
  const provider = new MockProvider({
    scripts: { ping: "pong" },
    ...providerOverrides,
  });
  const service = new ConversationService(store, provider);
  const app = buildApp({ config: mockConfig, service, serveUi: false });
  return { app, store, service };
}

type MockProviderOptionsShape = ConstructorParameters<typeof MockProvider>[0];

function parseSse(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: dataLine ? (JSON.parse(dataLine.slice("data: ".length)) as unknown) : null,
      };
    });
}

describe("GET /healthz", () => {
  it("reports status, provider, and model", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: "ok",
      provider: "mock",
      model: "za-mock-1",
      app: { name: "za.ai" },
    });
  });
});

describe("POST /api/chat", () => {
  it("starts a conversation and returns the assistant reply", async () => {
    const { app, store } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "ping" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.reply).toEqual({ role: "assistant", content: "pong" });
    expect(body.conversationId).toMatch(/[0-9a-f-]{36}/);
    // persisted with both messages
    const persisted = store.get(body.conversationId);
    expect(persisted?.messages).toHaveLength(2);
  });

  it("continues an existing conversation when conversationId is provided", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hello there" },
    });
    const { conversationId } = first.json();

    const second = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId, message: "and again" },
    });
    expect(second.statusCode).toBe(201);
    const conversation = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
    });
    expect(conversation.json().messages).toHaveLength(4);
  });

  it("rejects missing or empty messages with 400", async () => {
    const { app } = makeApp();
    const noMessage = await app.inject({ method: "POST", url: "/api/chat", payload: {} });
    expect(noMessage.statusCode).toBe(400);
    expect(noMessage.json().error.code).toBe("invalid_request");

    const emptyMessage = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "   " },
    });
    expect(emptyMessage.statusCode).toBe(400);
  });

  it("returns 404 for an unknown conversation id", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { conversationId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", message: "hi" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("maps provider failures to 502", async () => {
    const store = new InMemoryConversationStore();
    const failingProvider: ChatProvider = {
      name: "failing",
      model: "boom",
      complete: async () => {
        throw new ProviderError("upstream exploded", 503);
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<string> {
        throw new ProviderError("upstream exploded", 503);
      },
    };
    const service = new ConversationService(store, failingProvider);
    const app = buildApp({ config: mockConfig, service, serveUi: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hi" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("provider_error");
  });
});

describe("POST /api/chat/stream", () => {
  it("emits meta, delta, and done events then persists the reply", async () => {
    const { app, store } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: { message: "ping" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(response.payload);
    expect(events.map((e) => e.event)).toEqual(["meta", "delta", "done"]);
    const meta = events[0]?.data as { conversationId: string };
    expect(meta.conversationId).toMatch(/[0-9a-f-]{36}/);
    expect(events[1]?.data).toEqual({ text: "pong" });

    const persisted = store.get(meta.conversationId);
    expect(persisted?.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ]);
  });

  it("streams multi-chunk mock replies in order", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: { message: "tell me a story" },
    });
    const events = parseSse(response.payload);
    const deltas = events
      .filter((e) => e.event === "delta")
      .map((e) => (e.data as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe('[mock] You said: "tell me a story"');
  });
});

describe("conversations API", () => {
  it("lists, gets, and deletes conversations", async () => {
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hello world" } });

    const list = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(list.statusCode).toBe(200);
    const summaries = list.json().conversations;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ messageCount: 2, title: "hello world" });

    const id = summaries[0].id as string;
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toHaveLength(2);

    const removed = await app.inject({ method: "DELETE", url: `/api/conversations/${id}` });
    expect(removed.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
    expect(afterDelete.statusCode).toBe(404);
  });

  it("returns JSON 404s for unknown routes and unknown conversations", async () => {
    const { app } = makeApp();
    const unknownRoute = await app.inject({ method: "GET", url: "/nope" });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.json().error.code).toBe("not_found");

    const unknownConversation = await app.inject({
      method: "GET",
      url: "/api/conversations/does-not-exist",
    });
    expect(unknownConversation.statusCode).toBe(404);
  });
});
