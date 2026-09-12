import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HTTP_URL_PATTERN = /^https?:\/\//i;

const rawConfigSchema = z.object({
  PROVIDER: z.enum(["mock", "openai-compat"]).default("mock"),
  MODEL: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_BASE_URL: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || HTTP_URL_PATTERN.test(value), {
      message: "must be an http(s) URL",
    })
    .optional(),
  SYSTEM_PROMPT: z.string().optional(),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(1000).default(20),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(1).max(1_000_000).default(32_000),
  MAX_CONVERSATION_MESSAGES: z.coerce.number().int().min(2).max(10_000).default(200),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
});

interface BaseConfig {
  model: string;
  host: string;
  port: number;
  systemPrompt?: string | undefined;
  maxHistoryMessages: number;
  /** Maximum accepted length of a single user message (in characters). */
  maxMessageChars: number;
  /** Maximum number of messages retained per conversation. */
  maxConversationMessages: number;
  /** Timeout applied to non-streaming provider requests. */
  providerTimeoutMs: number;
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
    host: raw.HOST,
    port: raw.PORT,
    systemPrompt: raw.SYSTEM_PROMPT,
    maxHistoryMessages: raw.MAX_HISTORY_MESSAGES,
    maxMessageChars: raw.MAX_MESSAGE_CHARS,
    maxConversationMessages: raw.MAX_CONVERSATION_MESSAGES,
    providerTimeoutMs: raw.PROVIDER_TIMEOUT_MS,
  };

  switch (raw.PROVIDER) {
    case "mock":
      return {
        provider: "mock",
        ...base,
        model: raw.OPENAI_MODEL ?? raw.MODEL ?? "za-mock-1",
      };
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
        // Provider-specific override wins, then the general MODEL, then the default.
        model: raw.OPENAI_MODEL ?? raw.MODEL ?? "gpt-4o-mini",
        apiKey: raw.OPENAI_API_KEY,
        baseUrl: normalizeBaseUrl(raw.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      };
  }
}

/** Trims and strips trailing slashes so `…/v1/` and `…/v1` behave identically. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!HTTP_URL_PATTERN.test(trimmed)) {
    throw new ConfigError(`OPENAI_BASE_URL must be an http(s) URL, got: ${trimmed}`);
  }
  return trimmed;
}
