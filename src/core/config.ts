import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const rawConfigSchema = z.object({
  PROVIDER: z.enum(["mock", "openai-compat"]).default("mock"),
  MODEL: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_BASE_URL: z.string().trim().min(1).optional(),
  SYSTEM_PROMPT: z.string().optional(),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(1000).default(20),
});

interface BaseConfig {
  model: string;
  host: string;
  port: number;
  systemPrompt?: string | undefined;
  maxHistoryMessages: number;
}

export interface MockProviderConfig extends BaseConfig {
  provider: "mock";
}

export interface OpenAICompatProviderConfig extends BaseConfig {
  provider: "openai-compat";
  apiKey: string;
  baseUrl: string;
}

/** Discriminated by `provider` so downstream code can narrow safely. */
export type AppConfig = MockProviderConfig | OpenAICompatProviderConfig;

/**
 * Loads and validates configuration from an environment-like record.
 * Defaults are safe for local development: the mock provider needs no secrets.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration — ${issues}`);
  }
  const raw = parsed.data;

  const base = {
    model: raw.MODEL ?? (raw.PROVIDER === "mock" ? "za-mock-1" : "gpt-4o-mini"),
    host: raw.HOST,
    port: raw.PORT,
    systemPrompt: raw.SYSTEM_PROMPT,
    maxHistoryMessages: raw.MAX_HISTORY_MESSAGES,
  };

  switch (raw.PROVIDER) {
    case "mock":
      return { provider: "mock", ...base };
    case "openai-compat":
      if (!raw.OPENAI_API_KEY) {
        throw new ConfigError(
          "PROVIDER=openai-compat requires OPENAI_API_KEY to be set " +
            "(e.g. OPENAI_API_KEY=sk-…). Never commit real keys.",
        );
      }
      return {
        provider: "openai-compat",
        ...base,
        apiKey: raw.OPENAI_API_KEY,
        baseUrl: (raw.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      };
  }
}
