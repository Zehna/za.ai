import type { FastifyError, FastifyInstance } from "fastify";
import { ConfigError } from "../core/config.js";
import { ConversationNotFoundError } from "../core/conversation.js";
import { ProviderError } from "../core/provider.js";

/** Request body/query validation failure. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Maps domain errors to HTTP status codes and installs a JSON error handler
 * so every failure surfaces as { error: { code, message } }.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: { code: "invalid_request", message: error.message } });
    }
    if (error instanceof ConversationNotFoundError) {
      return reply.status(404).send({ error: { code: "not_found", message: error.message } });
    }
    if (error instanceof ProviderError || error instanceof ConfigError) {
      app.log.error({ err: error }, "provider failure");
      return reply.status(502).send({ error: { code: "provider_error", message: error.message } });
    }
    // Fastify's own client errors (malformed JSON, body too large, …).
    const statusCode = error.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { code: "invalid_request", message: error.message } });
    }
    app.log.error({ err: error }, "unexpected server error");
    return reply.status(500).send({
      error: { code: "internal_error", message: "Unexpected server error" },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
  });
}
