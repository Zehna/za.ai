# za.ai

Self-hostable AI assistant service with pluggable LLM providers.

- **HTTP chat API** (JSON + SSE streaming) — works with any OpenAI-compatible endpoint
  (OpenAI, Azure OpenAI, vLLM, Ollama, …) or with a built-in deterministic **mock
  provider** that needs no API key.
- **Minimal web chat UI** served by the same process.
- **Conversation history** with pluggable storage.
- Strict TypeScript, ESM, Fastify, Vitest. See [PROGRESS.md](./PROGRESS.md) for the
  implementation plan and current status.

## Requirements

- Node.js >= 22

## Quickstart

```bash
npm install

# Run the full verification suite (lint, format check, typecheck, tests, build)
npm run lint && npm run typecheck && npm run test && npm run build

# Start the server (mock provider, no API key needed)
npm start
```

## Development

```bash
npm run dev         # watch mode
npm run test:watch  # tests in watch mode
npm run format      # apply Prettier
```

## Configuration

Configuration is environment-driven (see `.env.example` once Milestone 5 lands).
The mock provider is the default so the app is runnable out of the box; switching
to a real model only requires:

```bash
PROVIDER=openai-compat \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.openai.com/v1 \
MODEL=gpt-4o-mini \
npm start
```

Never commit real API keys — use `.env` (git-ignored) or your deployment's secret store.

## License

MIT
