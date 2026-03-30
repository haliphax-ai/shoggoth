# Models: providers, failover, and transcript compaction

Shoggoth treats LLMs as **OpenAI-compatible** backends: HTTP `POST …/chat/completions` with JSON bodies and assistant text read from `choices[0].message.content`.

**Planned (runtime):** Anthropic Messages API provider in `@shoggoth/models` — see [anthropic-messages-plan.md](./anthropic-messages-plan.md). Config schema will add `kind: "anthropic-messages"` (origin `baseUrl`, optional `apiKeyEnv`, optional `anthropicVersion` / auth style) alongside `openai-compatible`.

Configuration lives under the top-level **`models`** object in layered JSON (merged with the rest of `shoggothConfigFragmentSchema` in `@shoggoth/shared`). Unknown keys are rejected.

## Streaming (SDK)

`createOpenAICompatibleProvider` supports optional **SSE** chat completions when callers pass `stream: true` on `ModelCompleteInput` / `ModelToolCompleteInput`. The JSON body includes `"stream": true`; the client reads `text/event-stream` chunks, merges `delta.content` and streaming `delta.tool_calls`, and returns the same shapes as non-streaming responses. Provide `onTextDelta?: (delta, accumulated) => void` to observe assistant text as it grows. Omit `stream` or set `stream: false` for the existing one-shot JSON behavior. `createFailoverToolCallingClient` and `createFailoverModelClient` forward these fields so streaming runs only on the provider hop that succeeds. The Discord platform wires `stream: true` when **`SHOGGOTH_DISCORD_STREAM=1`** (see [messaging.md](./messaging.md)).

## `models.providers`

Each entry describes one named backend:

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Stable id referenced by `failoverChain`. |
| `kind` | yes | `"openai-compatible"` (today) or `"anthropic-messages"` (planned; Messages API at `{origin}/v1/messages`). |
| `baseUrl` | yes | **OpenAI:** API root; `/v1` is appended if missing. **Anthropic:** origin only (no path); implementation normalizes to scheme+host. |
| `apiKeyEnv` | no | Env var name for the secret (`Authorization: Bearer` for OpenAI; `x-api-key` for Anthropic). Omitted → no auth header. |

Example:

```json
{
  "models": {
    "providers": [
      {
        "id": "primary",
        "kind": "openai-compatible",
        "baseUrl": "https://api.openai.com",
        "apiKeyEnv": "OPENAI_API_KEY"
      },
      {
        "id": "local",
        "kind": "openai-compatible",
        "baseUrl": "http://ollama:11434/v1"
      }
    ]
  }
}
```

## `models.failoverChain`

Ordered list of `{ "providerId", "model" }` hops. The runtime tries each hop in order until one completes successfully.

- If **`failoverChain` is missing or empty**, Shoggoth does **not** use `providers` from config. It builds a **single-hop chain from environment variables** (see below).
- Every `providerId` must match a `providers[].id` for an `openai-compatible` entry.

## Environment fallback (no `failoverChain`)

When `models.failoverChain` is absent or empty, `createFailoverClientFromModelsConfig` synthesizes one provider:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_BASE_URL` or `OLLAMA_HOST` | OpenAI-compatible base (normalized with `/v1`) | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | Bearer token for OpenAI-compatible hops | unset |
| `ANTHROPIC_BASE_URL` | Origin for Anthropic Messages (no `/v1` suffix in the env value) | unset until wired in code |
| `ANTHROPIC_API_KEY` | Secret for Anthropic (`x-api-key` or gateway equivalent) | unset until wired in code |
| `SHOGGOTH_MODEL` | Model id for the single hop | `gpt-4o-mini` |

Provider id is fixed as `env-default`. **Rule (once Anthropic env fallback is implemented):** prefer Anthropic when `ANTHROPIC_BASE_URL` is set (non-empty); otherwise use OpenAI envs as today — see plan doc.

**Readiness:** `tests/scripts/load-openclaw-env.mjs` sets `ANTHROPIC_*` when OpenClaw’s chosen provider has `api: "anthropic-messages"`, and `tests/docker-compose.readiness.yml` passes those variables into the container. Use `SHOGGOTH_READINESS_PROVIDER` to pick a specific `models.providers.<id>` entry.

## Failover and degraded mode

`@shoggoth/models` exposes `createFailoverModelClient`. On each `complete` call it:

1. Tries the first chain entry; on success returns `usedProviderId`, `usedModel`, and `degraded: false`.
2. On errors classified as **failover-eligible** (e.g. 429, 5xx, certain network failures), continues to the next entry. If a **later** entry succeeds, `degraded` is **true**.
3. On **non-eligible** errors (e.g. **401**), it **does not** advance; the error propagates.

Integrations (Discord, session loop) can surface `degraded` to operators when a backup provider answered.

## `models.compaction`

Controls **transcript compaction** (summarize the middle, keep system prefix + recent tail):

| Field | Default | Description |
| --- | --- | --- |
| `maxContextChars` | `80000` | When total transcript character count exceeds this, compaction may run (see `shouldAutoCompact` / `compactTranscriptIfNeeded`). |
| `preserveRecentMessages` | `8` | Count of **non-system** messages kept verbatim at the end after summarizing the middle. |
| `summaryMaxOutputTokens` | unset | Optional `max_tokens` for the summarization chat completion. |

**Automatic compaction:** `shouldAutoCompact(messages, policy)` is intended to be called from the session / tool loop before model calls when the in-memory transcript crosses the threshold.

**Operator-driven compaction:** use the CLI (below) or call `compactSessionTranscript` / `runSessionCompact` with `force: true` to summarize even when under the threshold (still subject to “must have a compressible middle” rules in `compactTranscriptIfNeeded`).

Compaction issues a model request with a fixed system prompt asking for a concise summary; the result is stored as an assistant message prefixed with `[Compacted context]`.

## CLI: compact a session transcript

From the host where the state DB and config are available:

```bash
npm run cli -- session compact <sessionId> [--force]
```

- Reads **`stateDbPath`** and **`models`** from layered config (`SHOGGOTH_CONFIG_DIR` or default layout).
- Applies migrations, then loads `transcript_messages` for the session, runs compaction policy + failover client, and **rewrites** transcript rows when compaction occurs.
- Prints JSON: `{ "compacted": boolean, "messageCount": number }`.

`--force` sets the same flag as `compactTranscriptIfNeeded({ force: true })`.

## Related packages

- `@shoggoth/shared` — Zod schema: `shoggothModelsConfigSchema`.
- `@shoggoth/models` — `createOpenAICompatibleProvider`, `createFailoverModelClient`, `createFailoverClientFromModelsConfig`, `resolveCompactionPolicyFromModelsConfig`, compaction helpers.
- `@shoggoth/daemon` — `compactSessionTranscript`, SQLite load/replace helpers in `transcript-compact`.
