import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../core/config.js";
import type { ConversationService } from "../core/conversation.js";
import type { ChatProvider } from "../core/provider.js";
import type { SecretRedactor } from "../core/redact.js";
import { createSecretRedactor } from "../core/redact.js";
import { registerErrorHandling } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";
import { registerStaticUi } from "./routes/static-ui.js";

/** Hard cap on JSON request bodies (1 MiB) — bounds request-parsing DoS. */
const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

export interface BuildAppOptions {
  config: AppConfig;
  service: ConversationService;
  provider: ChatProvider;
  /** Serves the built-in web UI from public/ (enabled for production/dev). */
  serveUi?: boolean;
  /** Applied to every error message sent to clients (secrets never leave). */
  redact?: SecretRedactor;
}

/** Constructs the Fastify application with all routes wired to the given service. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, service, provider } = options;
  const redact = options.redact ?? createSecretRedactor();

  const app: FastifyInstance = Fastify({
    logger: false,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  registerErrorHandling(app, { redact });
  registerHealthRoutes(app, config);
  registerChatRoutes(app, service, { maxMessageChars: config.maxMessageChars });
  registerConversationRoutes(app, service);
  registerDiagnosticsRoutes(app, config, provider);
  if (options.serveUi) {
    registerStaticUi(app);
  }

  return app;
}
