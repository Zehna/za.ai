import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../src/core/conversation.js";
import type { Conversation } from "../src/core/types.js";

function makeConversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    messages: [],
  };
}

describe("InMemoryConversationStore", () => {
  it("lists conversations most-recently-updated first", () => {
    const store = new InMemoryConversationStore();
    store.save(makeConversation("old", "2026-01-01T00:00:00.000Z"));
    store.save(makeConversation("new", "2026-01-02T00:00:00.000Z"));
    store.save(makeConversation("mid", "2026-01-01T12:00:00.000Z"));

    expect(store.list().map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  it("deletes by id and reports whether anything was removed", () => {
    const store = new InMemoryConversationStore();
    store.save(makeConversation("a", "2026-01-01T00:00:00.000Z"));
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.get("a")).toBeUndefined();
  });
});
