/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
/*
 * UI contract tests: these execute the real public/app.js inside jsdom with a
 * mocked fetch that streams SSE frames. They stand in for browser testing in
 * environments without a browser backend and cover the same behaviors.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = readFileSync(path.join(currentDir, "../public/app.js"), "utf8");

const PAGE_HTML = readFileSync(path.join(currentDir, "../public/index.html"), "utf8")
  // Strip external references so jsdom loads nothing over the network.
  .replace(/<link[^>]*>/g, "")
  .replace(/<script[^>]*><\/script>/g, "");

interface StreamController {
  enqueue: (chunk: string) => void;
  close: () => void;
  abort: () => void;
}

type FetchMock = ReturnType<typeof vi.fn> & {
  controllerRef: { current: StreamController | null };
};

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Builds a fetch mock returning a streaming SSE response driven by `enqueue`. */
function sseFetchMock({ onAborted }: { onAborted?: () => void } = {}): FetchMock {
  const controllerRef: { current: StreamController | null } = { current: null };
  const fetchMock = vi.fn(
    async (_url: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controllerRef.current = {
            enqueue: (chunk: string) => c.enqueue(new TextEncoder().encode(chunk)),
            close: () => c.close(),
            abort: () => c.error(new DOMException("Aborted", "AbortError")),
          };
        },
      });
      init?.signal?.addEventListener("abort", () => {
        onAborted?.();
        controllerRef.current?.abort();
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  return Object.assign(fetchMock, { controllerRef });
}

function diagnosticsFetchMock(): FetchMock {
  return vi.fn(async (url: unknown) => {
    if (String(url).includes("/api/diagnostics")) {
      return new Response(
        JSON.stringify({
          provider: "mock",
          model: "za-mock-1",
          baseUrl: null,
          apiKeyConfigured: false,
          connectivity: { checked: false },
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as FetchMock;
}

async function bootPage(fetchOverride?: unknown) {
  document.body.innerHTML = "";
  document.documentElement.innerHTML = PAGE_HTML.replace(/<\/?html[^>]*>/g, "")
    .replace(/<\/?head[^>]*>/g, "")
    .replace(/<\/?body[^>]*>/g, "");
  window.fetch = (fetchOverride ?? diagnosticsFetchMock()) as typeof fetch;
  window.TextDecoder = TextDecoder as unknown as typeof window.TextDecoder;
  window.ReadableStream = ReadableStream as unknown as typeof window.ReadableStream;
  window.Response = Response as unknown as typeof window.Response;
  window.DOMException = DOMException as unknown as typeof window.DOMException;

  // Execute the real UI script against the DOM.
  // eslint-disable-next-line no-new-func
  new Function(appJsSource)();

  // Let the diagnostics promise resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    messages: document.getElementById("messages")!,
    input: document.getElementById("input") as HTMLTextAreaElement,
    sendBtn: document.getElementById("send") as HTMLButtonElement,
    newChatBtn: document.getElementById("new-chat") as HTMLButtonElement,
    badge: document.getElementById("model-badge")!,
  };
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("chat UI (app.js in jsdom)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the provider and model from /api/diagnostics", async () => {
    const { badge } = await bootPage();
    expect(badge.textContent).toBe("mock · za-mock-1");
  });

  it("marks the badge as down when diagnostics are unreachable", async () => {
    const { badge } = await bootPage(vi.fn(async () => new Response("down", { status: 500 })));
    await tick();
    expect(badge.textContent).toBe("status unknown");
    expect(badge.className).toContain("badge-down");
  });

  it("streams the assistant reply incrementally and persists the conversation", async () => {
    const fetchMock = sseFetchMock();
    const { messages, input, sendBtn } = await bootPage(fetchMock);

    input.value = "ping";
    sendBtn.disabled = false;
    sendBtn.click();
    const controller = fetchMock.controllerRef.current!;

    await tick(2);
    controller.enqueue(sseFrame("meta", { conversationId: "conv-1" }));
    controller.enqueue(sseFrame("delta", { text: "pong" }));
    await tick(2);
    controller.enqueue(sseFrame("delta", { text: "!" }));
    await tick(2);
    controller.enqueue(sseFrame("done", { conversationId: "conv-1" }));
    controller.close();
    await tick();

    const bubbles = [...messages.querySelectorAll(".message")];
    expect(bubbles.map((b) => b.className)).toEqual(["message user", "message assistant"]);
    expect(bubbles[1]?.textContent).toBe("pong!");
    expect(window.localStorage.getItem("za.ai.conversationId")).toBe("conv-1");
    expect(sendBtn.textContent).toBe("Send");
  });

  it("toggles to Stop while streaming and aborts on click", async () => {
    let aborted = false;
    const fetchMock = sseFetchMock({ onAborted: () => (aborted = true) });
    const { messages, input, sendBtn } = await bootPage(fetchMock);

    input.value = "long story";
    sendBtn.disabled = false;
    sendBtn.click();
    await tick(2);
    const controller = fetchMock.controllerRef.current!;
    controller.enqueue(sseFrame("meta", { conversationId: "conv-2" }));
    controller.enqueue(sseFrame("delta", { text: "once " }));
    await tick(2);

    expect(sendBtn.textContent).toBe("Stop");
    expect(sendBtn.disabled).toBe(false);

    sendBtn.click(); // acts as Stop
    await tick(2);

    expect(aborted).toBe(true);
    expect(sendBtn.textContent).toBe("Send");
    const bubbles = [...messages.querySelectorAll(".message")];
    expect(bubbles.some((b) => b.textContent.includes("Generation stopped"))).toBe(true);
    // the partial reply is still rendered
    expect(messages.querySelector(".assistant")?.textContent).toContain("once");
  });

  it("shows a retriable error bubble when the provider fails and retry recovers", async () => {
    const fetchMock = sseFetchMock();
    const { messages, input, sendBtn } = await bootPage(fetchMock);

    input.value = "trigger failure";
    sendBtn.disabled = false;
    sendBtn.click();
    await tick(2);
    let controller = fetchMock.controllerRef.current!;
    controller.enqueue(sseFrame("meta", { conversationId: "conv-3" }));
    controller.enqueue(sseFrame("error", { message: "upstream exploded" }));
    controller.close();
    await tick();

    const errorBubble = messages.querySelector(".error");
    expect(errorBubble?.textContent).toContain("Provider error: upstream exploded");
    const retryBtn = errorBubble?.querySelector(".retry") as HTMLElement | null;
    expect(retryBtn).toBeTruthy();

    // The next fetch call (from Retry) gets a fresh stream controller.
    retryBtn!.click();
    await tick(2);
    controller = fetchMock.controllerRef.current!;
    controller.enqueue(sseFrame("meta", { conversationId: "conv-3" }));
    controller.enqueue(sseFrame("delta", { text: "recovered" }));
    controller.close();
    await tick();

    const lastBubble = [...messages.querySelectorAll(".message")].at(-1);
    expect(lastBubble?.textContent).toBe("recovered");
  });

  it("reflects HTTP errors (e.g. invalid input) as retriable errors", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/chat/stream")) {
        return new Response(
          JSON.stringify({ error: { code: "invalid_request", message: "message: too long" } }),
          { status: 400 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const { messages, input, sendBtn } = await bootPage(fetchMock);
    input.value = "will be rejected";
    sendBtn.disabled = false;
    sendBtn.click();
    await tick();

    const errorBubble = messages.querySelector(".error");
    expect(errorBubble?.textContent).toContain("message: too long");
    expect(errorBubble?.querySelector(".retry")).toBeTruthy();
  });

  it("New chat clears the transcript and stored conversation id", async () => {
    window.localStorage.setItem("za.ai.conversationId", "old-conv");
    const fetchMock = sseFetchMock();
    const { messages, newChatBtn } = await bootPage(fetchMock);
    messages.insertAdjacentHTML(
      "beforeend",
      '<div class="message user">old</div><div class="message assistant">stuff</div>',
    );

    newChatBtn.click();
    await tick();

    expect(window.localStorage.getItem("za.ai.conversationId")).toBeNull();
    expect(messages.querySelectorAll(".message")).toHaveLength(0);
    expect(messages.textContent).toContain("Ask anything");
  });

  it("keeps working when localStorage is unavailable", async () => {
    const failingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
      clear: () => {},
    };
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { value: failingStorage, configurable: true });

    const fetchMock = sseFetchMock();
    const { messages, input, sendBtn } = await bootPage(fetchMock);

    input.value = "storage test";
    sendBtn.disabled = false;
    sendBtn.click();
    await tick(2);
    const controller = fetchMock.controllerRef.current!;
    controller.enqueue(sseFrame("meta", { conversationId: "conv-9" }));
    controller.enqueue(sseFrame("delta", { text: "ok" }));
    controller.close();
    await tick();

    expect(messages.querySelector(".assistant")?.textContent).toBe("ok");
    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
