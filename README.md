# za.ai

Self-hostable AI assistant service with pluggable LLM providers.

- **HTTP chat API** (JSON + SSE streaming) — works with any OpenAI-compatible endpoint
  (OpenAI, Azure OpenAI, vLLM, Ollama, …) or with a built-in deterministic **mock
  provider** that needs no API key.
- **Minimal web chat UI** served by the same process at `/`.
- **Conversation history** with pluggable storage (in-memory first).
- Strict TypeScript, ESM, Fastify, Vitest. See [PROGRESS.md](./PROGRESS.md) for the
  implementation plan and current status.

## Requirements

- Node.js >= 22 (or Docker)

## Quickstart

```bash
npm install

# Run the full verification suite (lint, format check, typecheck, tests, build)
npm run lint && npm run typecheck && npm run test && npm run build

# Start the server (mock provider, no API key needed)
npm start
# → open http://localhost:3000
```

## Docker

```bash
docker build -t za.ai .
docker run --rm -p 3000:3000 za.ai                      # mock provider
docker run --rm -p 3000:3000 \
  -e PROVIDER=openai-compat -e OPENAI_API_KEY=sk-... \
  za.ai                                                 # real model
```

## Configuration

Configuration is environment-driven — see [.env.example](./.env.example) for all
variables (`PROVIDER`, `MODEL`, `PORT`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`SYSTEM_PROMPT`, `MAX_HISTORY_MESSAGES`). The mock provider is the default so the
app is runnable out of the box; switching to a real model only requires:

```bash
PROVIDER=openai-compat \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.openai.com/v1 \
MODEL=gpt-4o-mini \
npm start
```

Never commit real API keys — use `.env` (git-ignored) or your deployment's secret store.

## HTTP API

| Method   | Path                     | Description                                             |
| -------- | ------------------------ | ------------------------------------------------------- |
| `GET`    | `/healthz`               | Status, active provider/model, uptime                   |
| `POST`   | `/api/chat`              | Send a message, wait for the full reply                 |
| `POST`   | `/api/chat/stream`       | Send a message, receive the reply as server-sent events |
| `GET`    | `/api/conversations`     | List conversation summaries                             |
| `GET`    | `/api/conversations/:id` | Full conversation with messages                         |
| `DELETE` | `/api/conversations/:id` | Delete a conversation                                   |

Chat request body: `{"message": "..."}`, optionally `{"conversationId": "..."}` to
continue an existing conversation. Omitting `conversationId` starts a new one whose
id is returned (and reported as the SSE `meta` event).

SSE events: `meta` (`{conversationId}`), `delta` (`{text}`), `done`,
`error` (`{message}`).

Errors are always JSON: `{"error": {"code": "...", "message": "..."}}` with codes
`invalid_request` (400), `not_found` (404), `provider_error` (502),
`internal_error` (500).

## Development

```bash
npm run dev         # watch mode
npm run test:watch  # tests in watch mode
npm run format      # apply Prettier
```

Project layout: `src/core` (domain, provider abstraction), `src/server` (HTTP),
`public/` (web UI), `test/` (Vitest). CI runs lint + format check + typecheck +
tests + build on every push and pull request.

## License

MIT
