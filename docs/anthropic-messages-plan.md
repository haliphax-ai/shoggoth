# Plan: Anthropic Messages API support (including streaming)

This document scopes work to add a first-class **Anthropic Messages** provider to `@shoggoth/models`, wire it through config and environment (including readiness / OpenClaw Kiro), and support **streaming** for the same code paths OpenAI uses today (notably Discord when `SHOGGOTH_DISCORD_STREAM=1`).

## Goals

- Implement **`ModelProvider`** for Anthropic: `complete` and `completeWithTools`, so existing **`createFailoverModelClient`** / **`createFailoverToolCallingClient`** and daemon code stay interface-stable.
- Support **non-streaming** and **streaming** requests; streaming must invoke **`onTextDelta`** with the same semantics as `createOpenAICompatibleProvider` (delta + accumulated assistant-visible text for tool rounds).
- Extend **`models.providers`** in `@shoggoth/shared` with a new provider `kind` (e.g. `"anthropic-messages"`) and plumb **`from-config.ts`**.
- Align **readiness / `load-openclaw-env.mjs`** with OpenClaw providers where `api` is `anthropic-messages` (e.g. Kiro): correct base URL, API key header, and model id—without overloading `OPENAI_*` long term (see [Configuration](#configuration)).

## Non-goals (initial delivery)

- Prompt caching, extended thinking / new beta headers, PDF, computer-use, or other Anthropic features beyond core Messages + tools.
- Automatic **cross-protocol failover** (OpenAI hop then Anthropic hop) unless error classification is explicitly extended and tested.
- Changing Discord UX beyond what existing streaming batching already does.

## Current baseline (for contrast)

- All model HTTP today goes through **`createOpenAICompatibleProvider`**: `POST {base}/chat/completions`, Bearer auth, OpenAI JSON and SSE shapes (`packages/models/src/openai-compatible.ts`).
- Discord passes **`stream: true`** into **`completeWithTools`** when **`SHOGGOTH_DISCORD_STREAM=1`** and streaming outbound starts successfully (`packages/daemon/src/platforms/discord.ts` → `executeSessionAgentTurn`, `packages/daemon/src/sessions/session-tool-loop-model-client.ts`).

## Anthropic Messages API (target contract)

**Reference:** [Anthropic API – Messages](https://docs.anthropic.com/en/api/messages) (verify version headers and paths against the revision you implement against).

### Transport

- **URL:** `{origin}/v1/messages` (normalize `baseUrl` as **origin** without path; same spirit as OpenAI’s `/v1` normalization).
- **Headers (typical):**
  - `content-type: application/json`
  - `anthropic-version: 2023-06-01` (or configurable string)
  - `x-api-key: <secret>`  
  Gateways (e.g. Kiro) may also accept `Authorization: Bearer …`; support **configurable auth style** if needed for local proxies.
- **Body (conceptual):** `model`, `max_tokens`, `messages`, optional `system`, `tools`, `tool_choice`, `temperature`, `stream`.

### Response (non-streaming)

- Top-level `content` is an array of blocks: **`text`**, **`tool_use`** (id, name, input), etc.
- Map to existing **`ModelCompleteOutput`** / **`ModelToolCompleteOutput`** (`content` string + `toolCalls[]` with JSON string `arguments`).

### Streaming

- Not OpenAI SSE: Anthropic uses **distinct event types** (e.g. message lifecycle, content block start/delta/stop, tool input JSON deltas).
- Implement a dedicated **`consumeAnthropicMessagesStream`** (or similar) that:
  - Parses the stream incrementally.
  - Accumulates **assistant text** and, when `accumulateTools` is true, **tool_use** blocks (merge partial JSON for `input` if the API streams tool arguments).
  - Calls **`onTextDelta(delta, accumulated)`** for **text-only** deltas in a way that matches Discord’s expectations (assistant-visible string; see [Streaming parity](#streaming-parity-with-discord)).

## Architecture

### New module

- Add **`packages/models/src/anthropic-messages.ts`**:
  - `createAnthropicMessagesProvider(options)` → **`ModelProvider`**
  - Options: `id`, `baseUrl` (origin), `apiKey`, optional `anthropicVersion`, optional `fetchImpl`, optional `auth: "x-api-key" | "bearer"`
  - Private helpers: build request JSON, parse non-stream response, stream consumer.

### Message and tool mapping

Shared internal types: keep **`ChatMessage`** / **`OpenAIToolFunctionDefinition`** as the **canonical** transcript shape; convert at the HTTP boundary only.

| OpenAI / `ChatMessage` | Anthropic Messages |
| --- | --- |
| `role: "system"` messages | Collapse into top-level **`system`** (concatenate multiple system messages with `\n\n`, or use block array if needed later). |
| `role: "user"` / `"assistant"` with string `content` | `messages[]` with `role` + `content` string or content blocks. |
| `role: "assistant"` with `toolCalls` | Historical assistant turn must include **`tool_use`** blocks (`id`, `name`, `input` from `JSON.parse(arguments)`; validate and surface 502-style errors on bad JSON). |
| `role: "tool"` + `toolCallId` + `content` | **`user`** message whose `content` includes **`tool_result`** blocks referencing `tool_use_id`. |
| `tools[]` OpenAI shape | Map to Anthropic **`tools`** with `name`, `description`, `input_schema` ← same JSON Schema object as `parameters`. |
| `tool_choice: "auto"` | Set Anthropic equivalent (`auto`) for v1. |

Edge cases to document in tests:

- Assistant message with **only** `toolCalls` and null/empty `content`.
- Multiple tool results in one user turn vs one block per tool.
- Maximum request size / ordering constraints from Anthropic (tool_use immediately followed by tool_result in the next user turn).

### Errors

- Reuse **`ModelHttpError`** with status + body snippet (existing pattern in `openai-compatible.ts`).
- Map Anthropic error JSON to readable messages where stable.

## Streaming parity with Discord

The session layer uses **`createSessionToolLoopModelClient`**: when `streamModel` is true, it passes **`onTextDelta`** so **`onModelTextDelta`** receives **display** text (`priorRoundsStreamText + accumulated`).

Requirements for Anthropic streaming:

1. **`onTextDelta`** must fire for **incremental assistant text** in the **current** model turn (same as OpenAI).
2. When the model returns **tool calls** mid-stream, behavior should match OpenAI provider: final aggregated **`toolCalls`** + optional **`content`**; streaming path must not throw unless the OpenAI provider would throw in the same situation.
3. Tool-round **“reasoning” text** before tool calls should still stream if Anthropic emits text blocks before `tool_use` blocks.

## Configuration

### `models.providers` schema (`@shoggoth/shared`)

Extend Zod schema with a discriminated union, e.g.:

```json
{
  "id": "kiro",
  "kind": "anthropic-messages",
  "baseUrl": "http://kiro:8000",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "anthropicVersion": "2023-06-01"
}
```

Fields to define precisely in implementation:

- `baseUrl`: origin only vs allow path suffix (document normalization rules).
- `apiKeyEnv` vs inline secret (follow existing `openai-compatible` pattern: env name only in config).
- Optional `authHeader` / `auth` enum for gateway quirks.

### `from-config.ts`

- Build a `Map` of provider id → **`ModelProvider`** for both `openai-compatible` and `anthropic-messages`.
- **`failoverChain`** entries stay `{ providerId, model }`; model string is passed through to the provider as today.

### Environment fallback (no `failoverChain`)

Introduce parallel env vars (names TBD, example):

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Origin for `https://…` / `http://kiro:8000` |
| `ANTHROPIC_API_KEY` | Value for `x-api-key` |
| `SHOGGOTH_MODEL` | Model id for single hop (unchanged key if we keep one model env) |

Decision: either **(A)** a single **`SHOGGOTH_MODEL_PROVIDER=anthropic|openai`** switch, or **(B)** prefer Anthropic when `ANTHROPIC_BASE_URL` is set, else OpenAI envs. Document the chosen rule in `docs/models.md` after implementation.

### OpenClaw / readiness (`tests/scripts/load-openclaw-env.mjs`)

When `models.providers.kiro` (or any provider) has **`api: "anthropic-messages"`** in OpenClaw config:

- Export **`ANTHROPIC_BASE_URL`**, **`ANTHROPIC_API_KEY`**, and model id appropriate for Shoggoth.
- Ensure **`tests/docker-compose.readiness.yml`** passes through these variables (like `OPENAI_*` today).
- Keep **`OPENAI_*`** exports for LAN/OpenAI providers; avoid writing Anthropic secrets into unrelated vars.

## Phases / milestones

### Phase 0 — Spike (optional)

- `curl` / small script against Kiro: confirm exact URL, headers, and stream format (SSE vs HTTP/2) for Messages.

### Phase 1 — Non-streaming core

- `createAnthropicMessagesProvider`: `complete` + `completeWithTools`.
- Message/tool mapping + unit tests with **mock `fetch`** (follow `packages/models/test/openai-compatible.test.ts` patterns).
- Wire `kind` in schema + `from-config.ts` + minimal example JSON in docs.

### Phase 2 — Streaming

- Stream parser + `complete` / `completeWithTools` with `stream: true`.
- Tests: fixture stream bytes → expected deltas + final tool calls.
- Manual: Discord with `SHOGGOTH_DISCORD_STREAM=1` against Kiro.

### Phase 3 — Readiness & ops

- `load-openclaw-env.mjs` + compose env for Anthropic.
- Update **`docs/models.md`** to describe the new provider kind and env fallback.
- **`npm run test:readiness`** path validated with Kiro (health / Discord E2E as applicable).

### Phase 4 — Hardening (as needed)

- Rate limits / 429 handling alignment with `isFailoverEligibleError`.
- Redacted logging for provider errors.
- Optional mixed-provider failover design (separate RFC).

## Testing strategy

| Layer | Scope |
| --- | --- |
| Unit | Request JSON shape, response parsing, stream parsing, mapping edge cases, `ModelHttpError` on HTTP errors. |
| Integration | Daemon `test/platforms/discord.test.ts` with mocked provider (already pattern for tool loop); add cases for `stream: true` if not covered. |
| E2E | Manual or gated readiness with real Kiro; document env in `docs/runbook.md` or `models.md`. |

## Risks

- **Stream format drift** between Anthropic and Kiro proxy: mitigate with versioned parser tests and a “strict vs lenient” mode if the proxy omits events.
- **Tool argument JSON**: partial JSON during streaming must match Anthropic’s tool-input delta semantics; add golden tests.
- **Compaction** uses `complete` (non-tool): must work with Anthropic `complete` for summaries (same mapping layer).

## References (in-repo)

- `packages/models/src/types.ts` — `ModelProvider`, streaming callbacks.
- `packages/models/src/openai-compatible.ts` — reference implementation + SSE.
- `packages/models/src/from-config.ts` — provider factory wiring.
- `packages/shared/src/schema.ts` — `models` config schema.
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts` — streaming-capable model client for `runToolLoop`.
- `docs/models.md` — current provider documentation (update when implementing).

## Open questions (resolve during Phase 0–1)

1. Kiro’s exact path and headers: raw Anthropic-compatible or prefixed routes?
2. Single env namespace vs explicit `SHOGGOTH_MODEL_BACKEND` selector for fallback chain.
3. Whether to support **both** OpenAI and Anthropic env providers simultaneously without `failoverChain` (probably no for v1).
