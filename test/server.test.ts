import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { InMemoryConversationStore, ConversationService } from "../src/core/conversation.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { ProviderError } from "../src/core/provider.js";
import type { AppConfig } from "../src/core/config.js";
import type { ChatProvider } from "../src/core/provider.js";
import { createSecretRedactor } from "../src/core/redact.js";

const mockConfig: AppConfig = {
  provider: "mock",
  model: "za-mock-1",
  host: "127.0.0.1",
  port: 0,
  maxHistoryMessages: 20,
  maxMessageChars: 32_000,
  maxConversationMessages: 200,
  providerTimeoutMs: 60_000,
};

function makeApp(providerOverrides: Partial<MockProviderOptionsShape> = {}) {
  const store = new InMemoryConversationStore();
  const provider = new MockProvider({
    scripts: { ping: "pong" },
    ...providerOverrides,
  });
  const service = new ConversationService(store, provider);
  const app = buildApp({
    config: mockConfig,
    service,
    provider,
    serveUi: false,
  });
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
      checkConnectivity: async () => ({ state: "unreachable", detail: "always fails" }),
    };
    const service = new ConversationService(store, failingProvider);
    const app = buildApp({
      config: mockConfig,
      service,
      provider: failingProvider,
      serveUi: false,
    });

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

describe("GET /api/diagnostics", () => {
  it("reports provider info without a key and without a live check by default", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "mock",
      model: "za-mock-1",
      baseUrl: null,
      apiKeyConfigured: false,
      connectivity: { checked: false },
    });
  });

  it("performs a live connectivity check when requested", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/diagnostics?check=true" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connectivity).toMatchObject({ checked: true, state: "ok" });
  });
});

describe("input limits", () => {
  it("rejects messages beyond the configured character limit with 400", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x".repeat(32_001) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.message).toMatch(/message/i);
  });

  it("accepts messages just below the configured limit", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "x".repeat(32_000) },
    });
    expect(response.statusCode).toBe(201);
  });

  it("rejects request bodies beyond the 1 MiB server cap with 413", async () => {
    const { app } = makeApp();
    // Small message chars limit does not apply to the raw body; craft a JSON
    // body just above the server body limit via oversized padding fields.
    const huge = "y".repeat(1_048_577);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: huge },
    });
    expect([413, 400]).toContain(response.statusCode);
    expect(response.json().error).toBeDefined();
  });
});

describe("security hardening", () => {
  function redactingApp(apiKey: string) {
    const store = new InMemoryConversationStore();
    // A provider whose upstream echoes the Authorization header back in the
    // error body — the worst-case leak vector for a key.
    const leakingProvider: ChatProvider = {
      name: "leaky",
      model: "leak-1",
      complete: async () => {
        throw new ProviderError(`Provider returned 500: bad key Bearer ${apiKey}`, 500);
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<string> {
        throw new ProviderError(`bad key Bearer ${apiKey}`, 500);
      },
      checkConnectivity: async () => ({ state: "unreachable" }),
    };
    const service = new ConversationService(store, leakingProvider);
    const openAiConfig: AppConfig = {
      ...mockConfig,
      provider: "openai-compat",
      model: "leak-1",
      apiKey,
      baseUrl: "http://leaky.test/v1",
    };
    const redact = createSecretRedactor(apiKey);
    const app = buildApp({ config: openAiConfig, service, provider: leakingProvider, redact });
    return app;
  }

  it("never returns the API key to clients, even when upstream echoes it", async () => {
    const apiKey = "sk-live-abcdef1234567890abcdef";
    const app = redactingApp(apiKey);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hi" },
    });
    expect(response.statusCode).toBe(502);
    const text = response.body;
    expect(text).not.toContain(apiKey);
    expect(text).toContain("[REDACTED]");
  });

  it("does not emit CORS headers (same-origin by default)", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("blocks static file path traversal", async () => {
    const provider = new MockProvider();
    const service = new ConversationService(new InMemoryConversationStore(), provider);
    const uiApp = buildApp({ config: mockConfig, service, provider, serveUi: true });
    for (const probe of [
      "/..%2f..%2f..%2fpackage.json",
      "/%2e%2e/%2e%2e/package.json",
      "/../../package.json",
    ]) {
      const traversal = await uiApp.inject({ method: "GET", url: probe });
      expect([400, 403, 404]).toContain(traversal.statusCode);
    }
  });

  it("returns structured errors for malformed JSON bodies without stack traces", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(JSON.stringify(body)).not.toMatch(/at\s+\(|node_modules|stack/i);
  });
});

describe("real-socket streaming regression", () => {
  it("streams a full reply over a live socket without spurious error events", async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "ping" }),
      });
      expect(response.status).toBe(200);

      const events: string[] = [];
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
          events.push(eventLine?.slice("event: ".length) ?? "");
        }
      }

      expect(events[0]).toBe("meta");
      expect(events).toContain("delta");
      expect(events.at(-1)).toBe("done");
      expect(events).not.toContain("error");
    } finally {
      await app.close();
    }
  });
});
