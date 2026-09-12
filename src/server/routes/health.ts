import type { FastifyInstance } from "fastify";
import { appInfo } from "../../app-info.js";
import type { AppConfig } from "../../core/config.js";

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/healthz", async () => ({
    status: "ok",
    app: appInfo(),
    provider: config.provider,
    model: config.model,
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
