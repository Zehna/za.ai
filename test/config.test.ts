import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../src/core/config.js";

describe("loadConfig", () => {
  it("defaults to the mock provider on port 3000", () => {
    const config = loadConfig({});
    expect(config.provider).toBe("mock");
    expect(config.model).toBe("za-mock-1");
    expect(config.port).toBe(3000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.maxHistoryMessages).toBe(20);
  });

  it("reads explicit values from the environment", () => {
    const config = loadConfig({
      PROVIDER: "mock",
      MODEL: "my-model",
      PORT: "8080",
      HOST: "127.0.0.1",
      MAX_HISTORY_MESSAGES: "5",
      SYSTEM_PROMPT: "Be concise.",
    });
    expect(config.model).toBe("my-model");
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxHistoryMessages).toBe(5);
    expect(config.systemPrompt).toBe("Be concise.");
  });

  it("builds an openai-compat config when the API key is present", () => {
    const config = loadConfig({
      PROVIDER: "openai-compat",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "http://localhost:11434/v1/",
    });
    expect(config).toMatchObject({
      provider: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "http://localhost:11434/v1",
      model: "gpt-4o-mini",
    });
  });

  it("rejects openai-compat without an API key", () => {
    expect(() => loadConfig({ PROVIDER: "openai-compat" })).toThrow(ConfigError);
    expect(() => loadConfig({ PROVIDER: "openai-compat", OPENAI_API_KEY: "  " })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("rejects unknown providers and invalid ports", () => {
    expect(() => loadConfig({ PROVIDER: "holographic" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_HISTORY_MESSAGES: "1" })).toThrow(ConfigError);
  });
});
