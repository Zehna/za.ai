import { describe, expect, it, vi } from "vitest";
import { OpenAICompatProvider } from "../src/core/providers/openai-compat.js";
import { ProviderError } from "../src/core/provider.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Minimal fetch stub capturing the request and returning a queued response. */
function stubFetch(response: Response) {
  const fetchImpl = vi.fn(async () => response);
  return fetchImpl;
}

describe("OpenAICompatProvider.complete", () => {
  it("posts to {baseUrl}/chat/completions with bearer auth and parses the reply", async () => {
    const fetchImpl = stubFetch(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Hello there!" } }],
      }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      baseUrl: "http://provider.test/v1/",
      model: "test-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://provider.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "test-model",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message).toEqual({ role: "assistant", content: "Hello there!" });
    expect(response.model).toBe("test-model");
  });

  it("throws a ProviderError with the HTTP status on failure", async () => {
    const fetchImpl = stubFetch(jsonResponse({ error: "bad key" }, 401));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      name: "ProviderError",
      status: 401,
    });
  });

  it("wraps transport failures in a ProviderError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws when the response has no assistant message", async () => {
    const fetchImpl = stubFetch(jsonResponse({ choices: [] }));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("OpenAICompatProvider.stream", () => {
  it("yields content deltas and stops at [DONE]", async () => {
    const fetchImpl = stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{}}]}\n',
        "data: [DONE]\n",
        'data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n',
      ]),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("throws a ProviderError on HTTP errors", async () => {
    const fetchImpl = stubFetch(new Response("server exploded", { status: 500 }));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of provider.stream({ messages: [] })) {
        // consume
      }
    }).rejects.toMatchObject({ name: "ProviderError", status: 500 });
  });

  it("throws on malformed SSE JSON payloads", async () => {
    const fetchImpl = stubFetch(sseResponse(["data: {not-json}\n"]));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of provider.stream({ messages: [] })) {
        // consume
      }
    }).rejects.toMatchObject({ name: "ProviderError" });
  });
});
