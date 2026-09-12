import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../core/config.js";
import type { ConversationService } from "../core/conversation.js";
import { registerErrorHandling } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerStaticUi } from "./routes/static-ui.js";

export interface BuildAppOptions {
  config: AppConfig;
  service: ConversationService;
  /** Serves the built-in web UI from public/ (enabled for production/dev). */
  serveUi?: boolean;
}

/** Constructs the Fastify application with all routes wired to the given service. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: false,
  });

  registerErrorHandling(app);
  registerHealthRoutes(app, options.config);
  registerChatRoutes(app, options.service);
  registerConversationRoutes(app, options.service);
  if (options.serveUi) {
    registerStaticUi(app);
  }

  return app;
}
