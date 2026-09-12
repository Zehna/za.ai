/**
 * Provider smoke test — exercises the active provider end to end.
 *
 * Usage:
 *   npm run smoke:provider                       (uses environment configuration)
 *   PROVIDER=openai-compat OPENAI_API_KEY=sk-… \
 *   OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_MODEL=gpt-4o-mini \
 *     npm run smoke:provider
 *
 * Exits 0 on success. If no API key is configured, prints setup instructions
 * and exits 0 (this is not an application failure). Any real provider failure
 * prints redacted diagnostics and exits 1.
 */
import { loadConfig, ConfigError } from "../src/core/config.js";
import { createProvider } from "../src/core/provider-factory.js";

const PROBE_MESSAGE = "Reply with exactly the word: PONG";

function printSetupInstructions(): void {
  console.log(`
No OpenAI-compatible provider is configured — nothing to smoke-test.

To test a real endpoint, set these environment variables (e.g. in a .env file
or as Codespaces Secrets — never committed to git):

  PROVIDER=openai-compat
  OPENAI_API_KEY=<your key>
  OPENAI_BASE_URL=https://api.openai.com/v1   # or vLLM/Ollama/Azure gateway
  OPENAI_MODEL=gpt-4o-mini                    # or any model your gateway serves

Then re-run: npm run smoke:provider
`);
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Missing OPENAI_API_KEY is an expected, non-failure situation here.
      if (/OPENAI_API_KEY/.test(error.message)) {
        printSetupInstructions();
        return 0;
      }
      console.error(`Configuration error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log(`provider : ${config.provider}`);
  console.log(`model    : ${config.model}`);
  if (config.provider === "openai-compat") {
    console.log(`base url : ${config.baseUrl}`);
    console.log(`api key  : configured`);
  } else {
    console.log("(mock provider — round-trip sanity check only, no real model is contacted)");
  }

  const provider = createProvider(config);

  console.log("\n[1/3] connectivity check…");
  const connectivity = await provider.checkConnectivity();
  console.log(
    `       state=${connectivity.state}` +
      (connectivity.latencyMs !== undefined ? ` latency=${connectivity.latencyMs}ms` : "") +
      (connectivity.detail ? ` (${connectivity.detail})` : ""),
  );
  if (connectivity.state === "unreachable") {
    console.error("\nFAIL: provider is unreachable — see detail above.");
    return 1;
  }

  console.log("\n[2/3] non-streaming request…");
  const response = await provider.complete({
    messages: [{ role: "user", content: PROBE_MESSAGE }],
  });
  const completeText = response.message.content;
  console.log(`       reply (${completeText.length} chars): ${truncate(completeText, 120)}`);
  if (completeText.trim().length === 0) {
    console.error("\nFAIL: provider returned an empty completion.");
    return 1;
  }

  console.log("\n[3/3] streaming request…");
  const deltas: string[] = [];
  for await (const delta of provider.stream({
    messages: [{ role: "user", content: PROBE_MESSAGE }],
  })) {
    deltas.push(delta);
  }
  const streamedText = deltas.join("");
  console.log(
    `       ${deltas.length} deltas, ${streamedText.length} chars: ${truncate(streamedText, 120)}`,
  );
  if (deltas.length === 0 || streamedText.trim().length === 0) {
    console.error("\nFAIL: streaming produced no usable deltas.");
    return 1;
  }

  console.log("\nOK: provider round-trip completed successfully.");
  return 0;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
