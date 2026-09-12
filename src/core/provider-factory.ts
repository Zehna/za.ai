import type { AppConfig } from "./config.js";
import type { ChatProvider } from "./provider.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAICompatProvider } from "./providers/openai-compat.js";

/** Builds the provider selected by configuration. */
export function createProvider(config: AppConfig): ChatProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider();
    case "openai-compat":
      return new OpenAICompatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.providerTimeoutMs,
      });
  }
}
