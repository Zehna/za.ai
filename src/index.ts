import { buildApp } from "./server/app.js";
import { loadConfig, ConfigError } from "./core/config.js";
import { ConversationService, InMemoryConversationStore } from "./core/conversation.js";
import { createProvider } from "./core/provider-factory.js";
import { createSecretRedactor } from "./core/redact.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const provider = createProvider(config);
  const store = new InMemoryConversationStore();
  const service = new ConversationService(store, provider, {
    maxHistoryMessages: config.maxHistoryMessages,
    maxConversationMessages: config.maxConversationMessages,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
  });

  // The API key never enters logs or HTTP responses: every client-facing
  // error message passes through this redactor.
  const redact =
    config.provider === "openai-compat"
      ? createSecretRedactor(config.apiKey)
      : createSecretRedactor();

  const app = buildApp({ config, service, provider, serveUi: true, redact });

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `${config.provider}/${config.model} listening on http://${config.host}:${config.port}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
