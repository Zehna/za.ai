import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider-factory.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { OpenAICompatProvider } from "../src/core/providers/openai-compat.js";

describe("createProvider", () => {
  it("creates a MockProvider for the mock config", () => {
    const provider = createProvider({
      provider: "mock",
      model: "za-mock-1",
      host: "0.0.0.0",
      port: 3000,
      maxHistoryMessages: 20,
    });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.model).toBe("za-mock-1");
  });

  it("creates an OpenAICompatProvider with the configured options", () => {
    const provider = createProvider({
      provider: "openai-compat",
      model: "llama-3",
      host: "0.0.0.0",
      port: 3000,
      maxHistoryMessages: 20,
      apiKey: "test-key",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.model).toBe("llama-3");
  });
});
