import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../core/config.js";
import type { ChatProvider, ConnectivityResult } from "../../core/provider.js";

interface DiagnosticsQuery {
  check?: string;
}

interface DiagnosticsResponse {
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  connectivity:
    | { checked: false }
    | {
        checked: true;
        state: ConnectivityResult["state"];
        latencyMs?: number | undefined;
        detail?: string | undefined;
      };
}

/**
 * Safe provider diagnostics: reports *whether* a key is configured (boolean
 * only — never the key itself), the resolved model and base URL, and — when
 * `?check=true` is passed — performs a live reachability/auth check.
 */
export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  provider: ChatProvider,
): void {
  app.get<{ Querystring: DiagnosticsQuery }>("/api/diagnostics", async (_request, reply) => {
    const wantsLiveCheck = _request.query.check === "true" || _request.query.check === "1";

    const result: DiagnosticsResponse = {
      provider: config.provider,
      model: config.model,
      baseUrl: config.provider === "openai-compat" ? config.baseUrl : null,
      apiKeyConfigured: config.provider === "openai-compat",
      connectivity: { checked: false },
    };

    if (wantsLiveCheck) {
      const check = await provider.checkConnectivity();
      result.connectivity = {
        checked: true,
        state: check.state,
        ...(check.latencyMs !== undefined ? { latencyMs: check.latencyMs } : {}),
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
      };
    }

    return reply.send(result);
  });
}
