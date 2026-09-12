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

  it("lets OPENAI_MODEL override MODEL for the openai-compat provider", () => {
    const config = loadConfig({
      PROVIDER: "openai-compat",
      OPENAI_API_KEY: "sk-test",
      MODEL: "generic-model",
      OPENAI_MODEL: "gateway-model",
    });
    expect(config.model).toBe("gateway-model");
  });

  it("uses MODEL as fallback when OPENAI_MODEL is absent (openai-compat)", () => {
    const config = loadConfig({
      PROVIDER: "openai-compat",
      OPENAI_API_KEY: "sk-test",
      MODEL: "generic-model",
    });
    expect(config.model).toBe("generic-model");
  });

  it("keeps OPENAI_MODEL working for the mock provider too", () => {
    const config = loadConfig({ OPENAI_MODEL: "weird-but-allowed" });
    expect(config.model).toBe("weird-but-allowed");
  });

  it("normalizes trailing slashes of OPENAI_BASE_URL", () => {
    const config = loadConfig({
      PROVIDER: "openai-compat",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "http://gw.test/v1///",
    });
    expect(config).toMatchObject({ baseUrl: "http://gw.test/v1" });
  });

  it("rejects non-http(s) base URLs", () => {
    expect(() =>
      loadConfig({
        PROVIDER: "openai-compat",
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "ftp://gw.test/v1",
      }),
    ).toThrow(/http\(s\)/);
  });

  it("defaults and clamps the new safety limits", () => {
    const config = loadConfig({});
    expect(config.maxMessageChars).toBe(32_000);
    expect(config.maxConversationMessages).toBe(200);
    expect(config.providerTimeoutMs).toBe(60_000);

    expect(() => loadConfig({ MAX_MESSAGE_CHARS: "1000001" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_MESSAGE_CHARS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_CONVERSATION_MESSAGES: "1" })).toThrow(ConfigError);
    expect(() => loadConfig({ PROVIDER_TIMEOUT_MS: "50" })).toThrow(ConfigError);
  });
});
