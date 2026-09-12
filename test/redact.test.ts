import { describe, expect, it } from "vitest";
import { createSecretRedactor } from "../src/core/redact.js";

describe("createSecretRedactor", () => {
  it("replaces occurrences of the configured secret", () => {
    const redact = createSecretRedactor("sk-abcdef1234567890abcdef1234567890");
    const out = redact("auth failed for key sk-abcdef1234567890abcdef1234567890 upstream");
    expect(out).toBe("auth failed for key [REDACTED] upstream");
  });

  it("redacts multiple distinct secrets", () => {
    const redact = createSecretRedactor("alpha-secret-value", "beta-secret-value");
    expect(redact("alpha-secret-value and beta-secret-value")).toBe("[REDACTED] and [REDACTED]");
  });

  it("ignores secrets below the minimum length", () => {
    const redact = createSecretRedactor("abc");
    expect(redact("abc def abc")).toBe("abc def abc");
  });

  it("redacts bearer tokens even when the raw key is absent", () => {
    const redact = createSecretRedactor();
    expect(redact("authorization: Bearer ghz_1234567890abcdef sent")).toBe(
      "authorization: Bearer [REDACTED] sent",
    );
  });

  it("redacts sk-prefixed keys even when the raw key is absent", () => {
    const redact = createSecretRedactor();
    expect(redact("leaked: sk-abcdef1234567890abcdef")).toBe("leaked: [REDACTED]");
  });

  it("leaves clean text untouched", () => {
    const redact = createSecretRedactor("sk-abcdef1234567890abcdef1234567890");
    expect(redact("nothing to see here")).toBe("nothing to see here");
  });
});
