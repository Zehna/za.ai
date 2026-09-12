/* za.ai chat UI — no build step, talks to the API on the same origin. */
(() => {
  "use strict";

  const STORAGE_KEY = "za.ai.conversationId";

  const messagesEl = document.getElementById("messages");
  const emptyStateEl = document.getElementById("empty-state");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const newChatBtn = document.getElementById("new-chat");
  const modelBadge = document.getElementById("model-badge");

  /** @type {string | null} */
  let conversationId = localStorage.getItem(STORAGE_KEY);
  /** @type {boolean} */
  let busy = false;

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value || inputEl.value.trim().length === 0;
  }

  function hideEmptyState() {
    if (emptyStateEl) emptyStateEl.remove();
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

  function showError(text) {
    addMessage("error", text);
  }

  async function checkHealth() {
    try {
      const response = await fetch("/healthz");
      if (!response.ok) throw new Error(`health check failed (${response.status})`);
      const body = await response.json();
      modelBadge.textContent = `${body.provider} · ${body.model}`;
      modelBadge.title = `provider: ${body.provider}, model: ${body.model}`;
    } catch {
      modelBadge.textContent = "unreachable";
    }
  }

  /**
   * POSTs to the SSE endpoint and parses "event:/data:" frames while streaming.
   * @param {string} message
   */
  async function streamChat(message) {
    const payload = { message };
    if (conversationId) payload.conversationId = conversationId;

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
        handleFrame(frame, message);
      }
    }
  }

  /** @type {HTMLElement | null} */
  let streamingEl = null;

  function handleFrame(frame, fallbackMessage) {
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
      localStorage.setItem(STORAGE_KEY, conversationId);
    } else if (event === "delta") {
      if (!streamingEl) streamingEl = addMessage("assistant", "");
      streamingEl.textContent += parsed.text;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (event === "error") {
      showError(`Provider error: ${parsed.message}`);
    }
    void fallbackMessage;
  }

  async function send() {
    const message = inputEl.value.trim();
    if (!message || busy) return;
    setBusy(true);
    addMessage("user", message);
    inputEl.value = "";
    inputEl.style.height = "auto";
    streamingEl = null;

    try {
      await streamChat(message);
    } catch (error) {
      showError(error instanceof Error ? error.message : "unexpected error");
    } finally {
      if (streamingEl && streamingEl.textContent === "") {
        streamingEl.textContent = "(empty response)";
      }
      streamingEl = null;
      setBusy(false);
      inputEl.focus();
    }
  }

  function newChat() {
    conversationId = null;
    localStorage.removeItem(STORAGE_KEY);
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
      send();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
    sendBtn.disabled = busy || inputEl.value.trim().length === 0;
  });

  newChatBtn.addEventListener("click", newChat);

  checkHealth();
  inputEl.focus();
})();
