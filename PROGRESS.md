# za.ai — Progress & Implementation Plan

## Status: In Progress — Milestones 0-2 complete

Last updated: 2026-09-12

> **⚠️ Push blocker:** `git push` currently fails because this environment has no
> GitHub credentials (`GITHUB_TOKEN` unset, `gh` not authenticated, credential helper
> returns nothing). All work is committed locally on `zai-development`; push once
> credentials are available (e.g. `gh auth login` or a codespace token with repo scope).

## What is za.ai?

> **Note on scope:** This repository contained no specification, issues, or source code
> (only an empty README) when work began. The product direction below was inferred from
> the repository name. It is intentionally modular so it can be redirected cheaply.
> Open questions for the owner are listed at the bottom of this file.

**za.ai** is a self-hostable AI assistant service:

- A TypeScript/Node backend exposing a small HTTP chat API (JSON + SSE streaming).
- A pluggable LLM provider layer — works out of the box with a deterministic
  mock provider (no API key needed) and with any OpenAI-compatible endpoint
  (OpenAI, Azure, local vLLM/Ollama, …) via environment configuration.
- A minimal built-in web chat UI served by the same process.
- Conversation history with pluggable storage (in-memory first, file-backed later).

## Architecture

```
src/
  core/          # domain, no I/O framework dependencies
    types.ts     # Message, Conversation, Role, …
    provider.ts  # ChatProvider interface + factory
    providers/   # mock.ts, openai-compat.ts
    conversation.ts  # ConversationService (create/append/reply, history trimming)
    config.ts    # env-driven configuration, validated
  server/        # Fastify HTTP layer
    app.ts       # buildApp() — routes, plugins, static files
    routes/      # chat.ts, conversations.ts, health.ts
  index.ts       # entrypoint: reads config, starts server
public/          # static web chat UI
test/            # unit + integration tests (Vitest)
```

Key decisions:

- **ESM + Node 24 + strict TypeScript.**
- **Fastify** for the HTTP layer (fast, schema-friendly, easy `inject()`-based tests).
- **Vitest** for unit/integration tests; **ESLint** (flat config) + **Prettier** for quality.
- The provider layer is interface-first so the mock provider keeps the full test
  suite and local demo runnable without secrets. No API keys are ever committed.

## Milestones

### Milestone 0 — Planning ✅

- [x] Inspect repository, confirm branch `zai-development`
- [x] Write this plan

### Milestone 1 — Project scaffold ✅

- [x] `package.json` with scripts: `dev`, `build`, `start`, `test`, `lint`, `format`, `typecheck`
- [x] `tsconfig.json` (strict, ESM, NodeNext) + `tsconfig.build.json` for emit builds
- [x] ESLint flat config + Prettier, `.gitignore`
- [x] Vitest wired up with a smoke test
- [x] GitHub Actions CI (lint + format + typecheck + test + build on push/PR)
- [x] README with quickstart

Verified: lint ✅ · format:check ✅ · typecheck ✅ · test (2 passed) ✅ · build ✅ · smoke run ✅

### Milestone 2 — Core domain

- [ ] `ChatProvider` interface (`complete` + streaming) and provider factory
- [ ] `MockProvider` (deterministic, echoes/scripted replies)
- [ ] `OpenAICompatProvider` (uses `fetch`, configurable `baseURL`/`model`/`apiKey`)
- [ ] `ConversationService`: create conversation, append messages, generate reply,
      history trimming to a max context
- [ ] Env-driven config with validation (provider, model, base URL, port, …)
- [ ] Unit tests for all of the above

### Milestone 2 — Core domain ✅

- [x] `ChatProvider` interface (`complete` + streaming) and provider factory
- [x] `MockProvider` (deterministic, echoes/scripted replies, chunked streaming)
- [x] `OpenAICompatProvider` (uses `fetch`, configurable `baseURL`/`model`/`apiKey`,
      SSE delta parsing, `ProviderError` with HTTP status, abort support)
- [x] `ConversationService`: create/list/get/delete, `turn()` and `streamTurn()`,
      history trimming to `maxHistoryMessages` + optional system prompt
- [x] `InMemoryConversationStore` (store interface ready for durable impls)
- [x] Env-driven config with zod validation, discriminated union per provider
- [x] Unit tests for all of the above

Verified: lint ✅ · format:check ✅ · typecheck ✅ · test (27 passed) ✅ · build ✅

### Milestone 3 — HTTP API

- [ ] `POST /api/chat` (JSON reply) and `POST /api/chat/stream` (SSE)
- [ ] `GET /api/conversations/:id`, `GET /api/conversations`
- [ ] `GET /healthz`
- [ ] Zod request validation + central error handling
- [ ] Integration tests via `fastify.inject()`

### Milestone 4 — Web UI

- [ ] Static chat page (vanilla HTML/JS, no build step) consuming the API
- [ ] Streaming display via SSE, conversation persistence in `localStorage`
- [ ] Verified against a running server (mock provider)

### Milestone 5 — Ops & polish

- [ ] Dockerfile (multi-stage, non-root)
- [ ] `.env.example` (no secrets), docs for provider configuration
- [ ] Final full verification: lint + typecheck + test + build + smoke run

## Verification checklist (run at every milestone)

```
npm run lint && npm run typecheck && npm run test && npm run build
```

## Blockers / Open questions

1. **Product direction is inferred** (see note above) — confirm or redirect.
2. **No LLM API key is available in this environment** — real provider inference is
   implemented but only exercised against the mock provider in tests. Provide
   `PROVIDER=openai-compat`, `OPENAI_API_KEY=…`, `OPENAI_BASE_URL=…` at runtime to use it.
3. `gh` CLI is not authenticated, so GitHub issues/PR metadata are not readable;
   working purely from the repo.
