/**
 * Central secret redaction. Provider errors and diagnostics flow through here
 * so an API key never reaches logs, HTTP responses, or the client.
 */
export interface SecretRedactor {
  (text: string): string;
}

const MIN_SECRET_LENGTH = 8;
const BEARER_PATTERN = /(bearer\s+)[^\s"',;)]+/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

/**
 * Builds a redactor for the given secret values. Any occurrence of a secret
 * (verbatim) in a text is replaced with [REDACTED]. Secrets shorter than
 * MIN_SECRET_LENGTH are ignored to avoid mangling normal text.
 */
export function createSecretRedactor(...secrets: Array<string | undefined>): SecretRedactor {
  const present = [
    ...new Set(
      secrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH),
    ),
  ];
  return function redact(text: string): string {
    if (typeof text !== "string") return text;
    let out = text;
    for (const secret of present) {
      out = out.split(secret).join("[REDACTED]");
    }
    // Defense in depth even when the raw key itself is not in the text.
    out = out.replace(BEARER_PATTERN, "$1[REDACTED]");
    out = out.replace(OPENAI_KEY_PATTERN, "[REDACTED]");
    return out;
  };
}
