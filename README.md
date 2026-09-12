# za.ai

Self-hostable AI assistant service with pluggable LLM providers.

- **HTTP chat API** (JSON + SSE streaming) — works with any OpenAI-compatible endpoint
  (OpenAI, Azure OpenAI, vLLM, Ollama, …) or with a built-in deterministic **mock
  provider** that needs no API key.
- **Minimal web chat UI** served by the same process at `/`, with streaming display,
  Stop generation, retry-after-error, and conversation persistence.
- **Conversation history** with pluggable storage (in-memory first) and configurable
  retention/size limits.
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

## Providers

### Mock provider (default)

`PROVIDER=mock` is active by default. It echoes your messages deterministically
(with optional scripted replies), needs no API key, and keeps the whole test
suite and local demo runnable offline.

### Real OpenAI-compatible endpoints

Any gateway that implements `POST {baseUrl}/chat/completions` works:

```bash
PROVIDER=openai-compat \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_MODEL=gpt-4o-mini \
npm start
```

- `OPENAI_MODEL` overrides the generic `MODEL` variable for this provider.
- `OPENAI_BASE_URL` must be `http(s)`; trailing slashes are normalized.
- Requests to a real provider never occur in the automated test suite — the mock
  provider covers those paths, and the OpenAI-compatible transport is tested with
  a stubbed `fetch`.

### Providing the API key safely

Never commit keys. Options, in order of preference:

1. **Codespaces Secrets** — Settings → Codespaces → Secrets → add `OPENAI_API_KEY`
   (and optionally `PROVIDER`/`OPENAI_BASE_URL`/`OPENAI_MODEL`). They appear as
   environment variables automatically.
2. **A git-ignored `.env` file** — copy [.env.example](./.env.example) to `.env`
   and source it (`set -a; . ./.env; set +a`).
3. **Your deployment's secret store** (Docker secrets, Kubernetes, systemd
   credentials, cloud secret managers).

The key is only ever read from the environment: it is never logged, never sent to
clients (error messages are redacted), and `/api/diagnostics` reports only
_whether_ a key is configured — a boolean.

### Provider smoke test

Verify a real endpoint end-to-end (connectivity, a non-streaming request, and a
streaming request with delta parsing):

```bash
npm run smoke:provider
# uses PROVIDER/OPENAI_* from the environment; with the mock provider it
# performs a local round-trip sanity check.
#
# Without a key it prints setup instructions and exits 0.
# On failure it prints redacted diagnostics and exits 1.
```

## Configuration

Configuration is environment-driven — see [.env.example](./.env.example) for all
variables. Limits that keep the service well-behaved:

| Variable                    | Default        | Purpose                                             |
| --------------------------- | -------------- | --------------------------------------------------- |
| `MAX_MESSAGE_CHARS`         | 32000          | Maximum accepted length of a single user message    |
| `MAX_CONVERSATION_MESSAGES` | 200            | Messages retained per conversation (oldest dropped) |
| `MAX_HISTORY_MESSAGES`      | 20             | Messages sent to the provider per request           |
| `PROVIDER_TIMEOUT_MS`       | 60000          | Timeout for non-streaming provider requests         |
| `PORT` / `HOST`             | 3000 / 0.0.0.0 | HTTP bind address                                   |

Request bodies are additionally capped at 1 MiB by the HTTP server.

## HTTP API

| Method   | Path                     | Description                                                 |
| -------- | ------------------------ | ----------------------------------------------------------- |
| `GET`    | `/healthz`               | Status, active provider/model, uptime                       |
| `GET`    | `/api/diagnostics`       | Provider info; `?check=true` runs a live connectivity check |
| `POST`   | `/api/chat`              | Send a message, wait for the full reply                     |
| `POST`   | `/api/chat/stream`       | Send a message, receive the reply as server-sent events     |
| `GET`    | `/api/conversations`     | List conversation summaries                                 |
| `GET`    | `/api/conversations/:id` | Full conversation with messages                             |
| `DELETE` | `/api/conversations/:id` | Delete a conversation                                       |

Chat request body: `{"message": "..."}`, optionally `{"conversationId": "..."}` to
continue an existing conversation. Omitting `conversationId` starts a new one whose
id is returned (and reported as the SSE `meta` event). Failed turns are atomic:
nothing is persisted, so clients can safely retry the same message.

SSE events: `meta` (`{conversationId}`), `delta` (`{text}`), `done`,
`error` (`{message}`).

Errors are always JSON: `{"error": {"code": "...", "message": "..."}}` with codes
`invalid_request` (400), `not_found` (404), `provider_error` (502),
`internal_error` (500). Stack traces and secrets are never included.

## Troubleshooting

- **`PROVIDER=openai-compat requires OPENAI_API_KEY`** at startup — the key is not
  in the environment. Re-check your Codespaces Secrets / `.env` sourcing.
- **502 `provider_error` on chat** — the upstream gateway rejected the request.
  The message includes the upstream status (redacted). Run
  `npm run smoke:provider` for a step-by-step diagnosis; `?check=true` on
  `/api/diagnostics` shows whether it is connectivity or authentication.
- **`Provider request timed out`** — the model took longer than
  `PROVIDER_TIMEOUT_MS`; raise it or use a faster model.
- **Streaming stops mid-reply** — client disconnects abort the upstream request;
  nothing is persisted for an interrupted turn.

## Development

```bash
npm run dev            # watch mode
npm run test:watch     # tests in watch mode
npm run smoke:provider # provider round-trip test
npm run format         # apply Prettier
```

Project layout: `src/core` (domain, provider abstraction), `src/server` (HTTP),
`public/` (web UI), `scripts/` (smoke test), `test/` (Vitest incl. jsdom UI
contract tests). CI runs lint + format check + typecheck + tests + build on every
push and pull request.

## License

MIT
