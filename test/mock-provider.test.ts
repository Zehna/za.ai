import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/core/providers/mock.js";

describe("MockProvider", () => {
  it("echoes the last user message in complete()", async () => {
    const provider = new MockProvider();
    const response = await provider.complete({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: '[mock] You said: "hello"' },
        { role: "user", content: "how are you?" },
      ],
    });
    expect(response.model).toBe("za-mock-1");
    expect(response.message.role).toBe("assistant");
    expect(response.message.content).toBe('[mock] You said: "how are you?"');
  });

  it("returns a fallback when there is no user message", async () => {
    const provider = new MockProvider();
    const response = await provider.complete({ messages: [{ role: "system", content: "sys" }] });
    expect(response.message.content).toMatch(/did not receive a user message/i);
  });

  it("prefers scripted replies for exact user messages", async () => {
    const provider = new MockProvider({ scripts: { ping: "pong" } });
    const response = await provider.complete({ messages: [{ role: "user", content: "ping" }] });
    expect(response.message.content).toBe("pong");
  });

  it("streams the full reply in chunks that reassemble exactly", async () => {
    const provider = new MockProvider({ scripts: { poem: "one two three" } });
    const deltas: string[] = [];
    for await (const delta of provider.stream({
      messages: [{ role: "user", content: "poem" }],
    })) {
      deltas.push(delta);
    }
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("one two three");
  });
});
