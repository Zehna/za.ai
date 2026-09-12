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
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{}}]}\n\n',
        "data: [DONE]\n\n",
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

describe("OpenAICompatProvider robustness", () => {
  function makeProvider(apiKey: string, response: Response, timeoutMs = 60_000) {
    const fetchImpl = stubFetch(response);
    return {
      fetchImpl,
      provider: new OpenAICompatProvider({
        apiKey,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs,
      }),
    };
  }

  it("rejects malformed JSON bodies in complete() with a ProviderError", async () => {
    const fetchImpl = stubFetch(
      new Response("<html>not json</html>", { headers: { "content-type": "application/json" } }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/malformed JSON/i);
  });

  it("rejects unexpected content types in complete()", async () => {
    const fetchImpl = stubFetch(
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(
      /unexpected provider content/i,
    );
  });

  it("rejects unexpected content types in stream()", async () => {
    const fetchImpl = stubFetch(jsonResponse({ choices: [] }));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of provider.stream({ messages: [] })) {
        // consume
      }
    }).rejects.toThrow(/unexpected provider content/i);
  });

  it("ignores SSE comments and blank lines", async () => {
    const fetchImpl = stubFetch(
      sseResponse([
        ": keep-alive comment\n",
        "\n",
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
        ": another comment\n",
        "\n",
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const delta of provider.stream({ messages: [] })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(["Hi"]);
  });

  it("joins multi-line data payloads per the SSE spec", async () => {
    const fetchImpl = stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":\n',
        'data: {"content":"split"}}]}\n\n',
        "data: [DONE]\n",
      ]),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const delta of provider.stream({ messages: [] })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(["split"]);
  });

  it("tolerates events with missing choices/delta fields", async () => {
    const fetchImpl = stubFetch(
      sseResponse([
        "data: {}\n\n",
        'data: {"choices":[]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n",
      ]),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const delta of provider.stream({ messages: [] })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(["ok"]);
  });

  it("includes upstream error bodies in the error message", async () => {
    const { provider } = makeProvider(
      "secret",
      new Response("upstream quota exceeded", { status: 429 }),
    );
    await expect(provider.complete({ messages: [] })).rejects.toThrow(
      /Provider returned 429: upstream quota exceeded/,
    );
  });

  it("aborts a non-streaming request when the external signal fires", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
        }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const pending = provider.complete({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it("reports a timeout when the provider does not answer in time", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
        }),
    );
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/timed out after 20ms/);
  });

  it("never leaks the API key through upstream error bodies", async () => {
    const apiKey = "sk-abcdef1234567890abcdef1234567890";
    const { provider } = makeProvider(
      apiKey,
      new Response(`bad key: ${apiKey} (Bearer ${apiKey})`, { status: 401 }),
    );
    const error = await provider.complete({ messages: [] }).catch((e: ProviderError) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).not.toContain(apiKey);
    expect(error.message).toContain("[REDACTED]");
  });
});

describe("OpenAICompatProvider.checkConnectivity", () => {
  it("reports ok with latency on success", async () => {
    const fetchImpl = stubFetch(jsonResponse({ data: [] }));
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.checkConnectivity();
    expect(result.state).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports authentication problems without leaking the key", async () => {
    const apiKey = "sk-abcdef1234567890abcdef1234567890";
    const fetchImpl = stubFetch(new Response("invalid key", { status: 401 }));
    const provider = new OpenAICompatProvider({
      apiKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.checkConnectivity();
    expect(result.state).toBe("unreachable");
    expect(result.detail).toMatch(/authentication/i);
    expect(result.detail).not.toContain(apiKey);
  });

  it("reports unreachable on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new OpenAICompatProvider({
      apiKey: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.checkConnectivity();
    expect(result.state).toBe("unreachable");
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });
});
