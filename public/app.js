/* za.ai chat UI — no build step, talks to the API on the same origin. */
(() => {
  "use strict";

  const STORAGE_KEY = "za.ai.conversationId";

  // --- resilient storage (private mode / disabled localStorage) ------------
  const memory = new Map();
  const storage = {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memory.has(key) ? memory.get(key) : null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        memory.delete(key);
      }
    },
  };

  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const newChatBtn = document.getElementById("new-chat");
  const modelBadge = document.getElementById("model-badge");

  /** @type {string | null} */
  let conversationId = storage.getItem(STORAGE_KEY);
  /** @type {boolean} */
  let busy = false;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {string | null} last user message, kept for Retry */
  let lastMessage = null;

  function setBusy(value) {
    busy = value;
    sendBtn.textContent = value ? "Stop" : "Send";
    sendBtn.disabled = value ? false : inputEl.value.trim().length === 0;
    sendBtn.classList.toggle("stop", value);
  }

  function hideEmptyState() {
    if (emptyStateEl && emptyStateEl.isConnected) emptyStateEl.remove();
  }

  function addMessage(role, text) {
    hideEmptyState();
    const el = document.createElement("div");
    el.className = `message ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addError(text, { retriable = false } = {}) {
    hideEmptyState();
    const el = document.createElement("div");
    el.className = "message error";
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);
    if (retriable && lastMessage) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        el.remove();
        send(lastMessage, { isRetry: true });
      });
      el.appendChild(retry);
    }
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addMarker(text) {
    const el = document.createElement("div");
    el.className = "message marker";
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  async function loadDiagnostics() {
    try {
      const response = await fetch("/api/diagnostics");
      if (!response.ok) throw new Error(`diagnostics failed (${response.status})`);
      const body = await response.json();
      modelBadge.textContent = `${body.provider} · ${body.model}`;
      modelBadge.classList.remove("badge-down");
      modelBadge.title =
        `provider: ${body.provider}` +
        (body.baseUrl ? `\nbase url: ${body.baseUrl}` : "") +
        `\napi key configured: ${body.apiKeyConfigured ? "yes" : "no"}`;
    } catch {
      modelBadge.textContent = "status unknown";
      modelBadge.classList.add("badge-down");
      modelBadge.title = "could not reach /api/diagnostics";
    }
  }

  /**
   * POSTs to the SSE endpoint and parses "event:/data:" frames while streaming.
   * @param {string} message
   * @param {AbortSignal} signal
   */
  async function streamChat(message, signal) {
    const payload = { message };
    if (conversationId) payload.conversationId = conversationId;

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok || !response.body) {
      let detail = `request failed (${response.status})`;
      try {
        const body = await response.json();
        if (body?.error?.message) detail = body.error.message;
      } catch {
        /* keep default detail */
      }
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        handleFrame(frame);
      }
    }
  }

  /** @type {HTMLElement | null} */
  let streamingEl = null;
  /** @type {Text | null} text node receiving streamed deltas */
  let streamingText = null;

  function handleFrame(frame) {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (event === "meta") {
      conversationId = parsed.conversationId;
      storage.setItem(STORAGE_KEY, conversationId);
    } else if (event === "delta") {
      if (!streamingEl || !streamingText) {
        streamingEl = addMessage("assistant", "");
        streamingText = document.createTextNode("");
        streamingEl.appendChild(streamingText);
      }
      streamingText.data += parsed.text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (event === "error") {
      if (streamingEl && streamingText && streamingText.data === "") streamingEl.remove();
      streamingEl = null;
      streamingText = null;
      addError(`Provider error: ${parsed.message}`, { retriable: true });
    }
  }

  async function send(messageOverride = null, { isRetry = false } = {}) {
    if (controller) {
      // The Send button is acting as Stop.
      controller.abort();
      return;
    }
    if (busy) return;
    const message = messageOverride ?? inputEl.value.trim();
    if (!message) return;

    setBusy(true);
    if (!isRetry) {
      addMessage("user", message);
      inputEl.value = "";
      inputEl.style.height = "auto";
    }
    lastMessage = message;
    streamingEl = addMessage("assistant", "");
    streamingText = document.createTextNode("");
    streamingEl.appendChild(streamingText);
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    cursor.textContent = "▍";
    streamingEl.appendChild(cursor);
    controller = new AbortController();

    try {
      await streamChat(message, controller.signal);
      if (streamingEl && streamingText && streamingText.data === "") streamingEl.remove();
    } catch (error) {
      const aborted =
        error instanceof DOMException
          ? error.name === "AbortError"
          : error instanceof Error && error.name === "AbortError";
      if (aborted) {
        if (streamingEl && streamingText && streamingText.data === "") streamingEl.remove();
        addMarker("Generation stopped — the partial reply above was not saved.");
      } else {
        if (streamingEl && streamingText && streamingText.data === "") streamingEl.remove();
        addError(error instanceof Error ? error.message : "unexpected error", {
          retriable: true,
        });
      }
    } finally {
      streamingEl?.querySelector(".cursor")?.remove();
      streamingEl = null;
      streamingText = null;
      controller = null;
      setBusy(false);
      inputEl.focus();
    }
  }

  function newChat() {
    if (controller) controller.abort();
    conversationId = null;
    lastMessage = null;
    storage.removeItem(STORAGE_KEY);
    messagesEl.innerHTML =
      '<div class="empty-state" id="empty-state"><p>Ask anything to start the conversation.</p></div>';
    inputEl.focus();
  }

  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    send();
  });

  document.getElementById("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!busy) send();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
    if (!busy) sendBtn.disabled = inputEl.value.trim().length === 0;
  });

  newChatBtn.addEventListener("click", newChat);

  setBusy(false);
  loadDiagnostics();
  inputEl.focus();
})();
