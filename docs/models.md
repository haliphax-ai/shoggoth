# @shoggoth/models — Reference

The `@shoggoth/models` package (`shoggoth/packages/models`) is the model abstraction layer for Shoggoth. It is consumed primarily by the [daemon](daemon.md) during agent turns and transcript compaction. It provides a provider-agnostic interface for LLM completions, a failover chain for multi-provider resilience, per-provider retry/backoff/rate-limit handling, transcript compaction, image codec support, and extended-thinking normalization.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Provider Abstraction](#provider-abstraction)
3. [Provider Implementations](#provider-implementations)
4. [Failover Chain](#failover-chain)
5. [Configuration & Model Selection](#configuration--model-selection)
6. [Resilience Layer](#resilience-layer)
7. [Error Classification](#error-classification)
8. [Invocation Parameters](#invocation-parameters)
9. [Transcript Compaction](#transcript-compaction)
10. [Image Codec](#image-codec)
11. [Extended Thinking](#extended-thinking)
12. [Token Usage Tracking](#token-usage-tracking)
13. [Type Reference](#type-reference)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Daemon / Session                       │
│                                                          │
│  createFailoverClientFromModelsConfig(config)            │
│  createFailoverToolCallingClientFromModelsConfig(config)  │
└──────────────┬───────────────────────────┬───────────────┘
               │                           │
     FailoverModelClient        FailoverToolCallingClient
        .complete()               .completeWithTools()
               │                           │
               ▼                           ▼
     ┌─────────────────────────────────────────┐
     │          Failover Loop                   │
     │  for each entry in chain:                │
     │    skip if hooks.isProviderFailed()      │
     │    try provider.complete/WithTools()     │
     │    on success → hooks.onProviderSuccess  │
     │    on failover-eligible error → next hop │
     │    on exhaust → hooks.onProviderExhausted│
     └──────────────┬──────────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
  Anthropic     OpenAI-Compat    Gemini
  Messages      Provider         Provider
     │              │              │
     ▼              ▼              ▼
  Resilience Gate (per-provider retry, backoff, concurrency)
     │              │              │
     ▼              ▼              ▼
  HTTP fetch    HTTP fetch     HTTP fetch
```

---

## Provider Abstraction

Every provider implements the `ModelProvider` interface:

```typescript
interface ModelProvider {
  readonly id: string;
  readonly capabilities?: ModelCapabilities;
  complete(input: ModelCompleteInput): Promise<ModelCompleteOutput>;
  completeWithTools(input: ModelToolCompleteInput): Promise<ModelToolCompleteOutput>;
}
```

- `complete()` — plain text completion (no tool calling). Returns `{ content: string, usage? }`.
- `completeWithTools()` — completion with OpenAI-style function tool definitions. Returns `{ content: string | null, toolCalls: ChatToolCall[], usage? }`.

Both methods support streaming (`stream: true`) with an `onTextDelta` callback.

### ModelCapabilities

```typescript
interface ModelCapabilities {
  readonly imageInput?: boolean;
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
}
```

- `imageInput` — whether the provider accepts image content parts.
- `thinkingFormat` — how extended thinking is surfaced: native blocks (Anthropic), XML tags (DeepSeek-style), or not at all.

---

## Provider Implementations

### OpenAI-Compatible (`openai-compatible`)

Factory: `createOpenAICompatibleProvider(options)`

```typescript
interface OpenAICompatibleProviderOptions {
  id: string;
  baseUrl: string; // Must include /v1 suffix
  apiKey?: string;
  fetchImpl?: FetchLike;
}
```

- Endpoint: `{baseUrl}/chat/completions`
- Auth: `Authorization: Bearer {apiKey}`
- Supports `reasoning_effort` via `requestExtras` or `reasoningEffort` param.
- Streaming uses SSE with `data:` lines and `[DONE]` sentinel.
- Usage extracted from `usage.prompt_tokens` / `usage.completion_tokens`.

### Anthropic Messages (`anthropic-messages`)

Factory: `createAnthropicMessagesProvider(options)`

```typescript
interface AnthropicMessagesProviderOptions {
  id: string;
  baseUrl: string; // Origin only (no path); requests go to {origin}/v1/messages
  apiKey?: string;
  anthropicVersion?: string; // Default: "2023-06-01"
  auth?: "x-api-key" | "bearer";
  fetchImpl?: FetchLike;
}
```

- Endpoint: `{origin}/v1/messages`
- Auth: `x-api-key` header (default) or `Authorization: Bearer` for gateways.
- Default `max_tokens`: 4096. Default thinking budget: 10,000 tokens.
- Tool names are sanitized to match `^[a-zA-Z0-9_-]{1,64}$` (dots/colons replaced with `_`, collisions resolved with numeric suffixes).
- Model IDs with slashes (e.g. `namespace/model`) are stripped to the part after the first `/`.
- System messages are collapsed into a single top-level `system` string.
- Tool messages are batched into `tool_result` content blocks under a `user` role.
- Streaming uses Anthropic SSE format (`event:` / `data:` lines, `message_start` → `content_block_start` → deltas → `content_block_stop` → `message_stop`).

### Gemini (`gemini`)

Factory: `createGeminiProvider(options)`

```typescript
interface GeminiProviderOptions {
  id: string;
  baseUrl?: string; // Default: "https://generativelanguage.googleapis.com"
  apiKey?: string;
  apiVersion?: string; // Default: "v1beta"
  fetchImpl?: FetchLike;
}
```

- Endpoint: `{baseUrl}/{apiVersion}/models/{model}:generateContent` (or `:streamGenerateContent?alt=sse` for streaming).
- Auth: `x-goog-api-key` header.
- System messages → `systemInstruction.parts[].text`.
- Assistant role mapped to `"model"`.
- Tool calls use `functionCall` / `functionResponse` format.
- Tool results: consecutive `tool` messages batched into one `{ role: "tool", parts: [{ functionResponse }...] }`.
- Tool call IDs auto-generated as `gemini-call-{index}` when the API doesn't return one.
- Safety filter triggers throw `ModelHttpError(400)`.
- Usage extracted from `usageMetadata.promptTokenCount` / `candidatesTokenCount`.

---

## Failover Chain

The failover chain walks an ordered list of `(provider, model)` entries. On a failover-eligible error, the next entry is tried.

### Creating a Failover Client

```typescript
// From config (preferred):
const client = createFailoverClientFromModelsConfig(modelsConfig, { hooks });
const toolClient = createFailoverToolCallingClientFromModelsConfig(modelsConfig, { hooks });

// Manual:
const client = createFailoverModelClient(chain, hooks);
const toolClient = createFailoverToolCallingClient(chain, hooks);
```

### FailoverChainEntry

```typescript
interface FailoverChainEntry {
  provider: ModelProvider;
  model: string;
  thinkingFormat?: "native" | "xml-tags" | "none";
  contextWindowTokens?: number; // Override from provider model definition
}
```

### Failover Hooks (Dependency Injection)

The daemon wires DB-backed provider failure tracking via hooks:

```typescript
interface FailoverHooks {
  isProviderFailed?(providerId: string): boolean; // Skip if true
  onProviderExhausted?(providerId: string, error?: string): void;
  onProviderSuccess?(providerId: string): void;
}
```

### Failover Logic

1. For each entry in the chain:
   - If `hooks.isProviderFailed(providerId)` returns `true`, skip.
   - Call `provider.complete()` or `provider.completeWithTools()`.
   - On success: call `hooks.onProviderSuccess()`, return result with `degraded: true` if `i > 0`.
   - On failover-eligible error and more entries remain: call `hooks.onProviderExhausted()`, continue to next.
   - On non-eligible error or last entry: throw.
2. Output includes `usedProviderId`, `usedModel`, `degraded`, and `thinkingFormat`.

### Failover-Eligible Errors

Determined by `isFailoverEligibleError()` in `classify.ts`:

| Condition                                   | Eligible?             |
| ------------------------------------------- | --------------------- |
| `ModelHttpError` with status 429            | Yes                   |
| `ModelHttpError` with status 500–599        | Yes                   |
| `TypeError` with message containing "fetch" | Yes (network failure) |
| Everything else                             | No                    |

---

## Configuration & Model Selection

### From Config (`from-config.ts`)

`createFailoverClientFromModelsConfig(modelsConfig, options)` reads `ShoggothModelsConfig`:

- `models.providers` — map of provider id → provider definition (`kind`, `baseUrl`, `apiKey`/`apiKeyEnv`, etc.) — see [Shared — Configuration Schema](shared.md#configuration-schema) for the full Zod schema
- `models.failoverChain[]` — array of `"providerId/modelName"` strings.
- `models.providers.<id>.models.<name>` — per-model overrides (`thinkingFormat`, `contextWindowTokens`), a map keyed by model name: the key is the model name and the body carries only the overrides.
- `models.requestTimeoutMs` — top-level request timeout (ms) applied to all provider API requests.
- `models.providers.<id>.requestTimeoutMs` — per-provider request timeout (ms); overrides the top-level value for that provider only.

When `failoverChain` is empty or absent, a single-hop provider is created from environment variables.

### Request Timeout

By default, provider API requests inherit Node's internal `fetch` timeouts (undici's ~300 s idle limits for receiving response headers and for gaps between body chunks). To tune this — for example to allow a slower local provider such as a LAN Ollama instance more time — set a timeout in configuration:

```jsonc
{
  "models": {
    // Applies to every provider…
    "requestTimeoutMs": 600000,
    "providers": {
      "ollama": {
        "kind": "openai-compatible",
        "baseUrl": "http://192.168.1.10:11434/v1",
        // …except this one, which overrides it.
        "requestTimeoutMs": 1800000,
      },
    },
  },
}
```

The timeout is enforced as an idle timeout per phase (response headers, then between body chunks) via an undici `Agent` dispatcher, so long-running but actively streaming responses are not cut off — only stalled requests are. A provider-level `requestTimeoutMs` always wins over the top-level `models.requestTimeoutMs`; when neither is set, Node's built-in defaults apply.

### Environment Variable Fallback

Priority order when no `failoverChain` is configured:

| Env Var                                       | Provider           | Default Model                |
| --------------------------------------------- | ------------------ | ---------------------------- |
| `ANTHROPIC_BASE_URL` set                      | Anthropic Messages | `claude-3-5-sonnet-20241022` |
| `GEMINI_API_KEY` set                          | Gemini             | `gemini-2.5-flash`           |
| `OPENAI_BASE_URL` or `OLLAMA_HOST` or default | OpenAI-Compatible  | `gpt-4o-mini`                |

`SHOGGOTH_MODEL` overrides the default model name in all cases.

Additional env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_VERSION`, `ANTHROPIC_AUTH` (`"bearer"` for gateway mode), `OPENAI_API_KEY`, `GEMINI_BASE_URL`.

### Compaction Policy from Config

```typescript
resolveCompactionPolicyFromModelsConfig(modelsConfig);
// → { preserveRecentMessages: number, summaryMaxOutputTokens?: number }
// Default preserveRecentMessages: 8
```

---

## Resilience Layer

Located in `src/resilience/`. Provides per-provider retry, exponential backoff, concurrency gating, and rate-limit header parsing.

### ModelResilienceGate (Singleton)

```typescript
// Set globally (daemon startup):
setResilienceGate(new ModelResilienceGate(globalDefaults, providerOverrides));

// Retrieved by providers automatically:
const gate = getResilienceGate();
```

Every provider's HTTP calls go through `gate.executeWithResilience(providerId, fn)`:

1. `acquireSlot()` — wait for cooldown, then acquire a concurrency slot.
2. Execute `fn()`.
3. On success: `recordSuccess()` (resets backoff), release slot.
4. On retryable/rate-limited error and `attempt < maxRetries`: `recordFailure()`, release slot, wait backoff delay, retry.
5. On non-retryable error or retries exhausted: throw, release slot.

### Backoff Configuration

```typescript
// Defaults:
{
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterMs: 500,
  maxRetries: 3,
}
```

Delay formula: `min(maxDelayMs, baseDelayMs × 2^attempt) + random(0, jitterMs)`. If the server sends `Retry-After` and it exceeds the computed delay, the `Retry-After` value is used instead.

### ProviderResilienceManager

Per-provider state tracking:

- Concurrency gate (default max: 5 in-flight requests, configurable via `concurrency`).
- Backoff state (exponential with jitter, reset on success).
- Rate tracking: sliding 60-second window of request timestamps.
- Learned capacity: updated from `x-ratelimit-limit-requests` headers.
- `isNearCapacity(threshold=0.8)` — true when requests in window ≥ 80% of learned limit.

### Error Classification (Resilience)

`classifyModelError(status, code)` returns:

| Input                                                   | Classification  |
| ------------------------------------------------------- | --------------- |
| Status 429                                              | `rate_limited`  |
| Status 408, 500, 502, 503, 504                          | `retryable`     |
| Network codes `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED` | `retryable`     |
| Everything else                                         | `non_retryable` |

### Rate-Limit Header Parsing

`parseRateLimitHeaders(providerId, headers, providerKind)` extracts:

```typescript
interface ParsedRateLimitHeaders {
  requestLimit?: number;
  requestsRemaining?: number;
  requestResetMs?: number;
  tokenLimit?: number;
  tokensRemaining?: number;
  tokenResetMs?: number;
  retryAfterMs?: number;
}
```

Provider-specific header mappings:

| Provider Kind                     | Request Limit Header         | Remaining Header                 | Token Headers                                              |
| --------------------------------- | ---------------------------- | -------------------------------- | ---------------------------------------------------------- |
| `anthropic` / `openai-compatible` | `x-ratelimit-limit-requests` | `x-ratelimit-remaining-requests` | `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` |
| `gemini`                          | `x-ratelimit-limit`          | `x-ratelimit-remaining`          | —                                                          |

Reset values are parsed as epoch seconds (>year 2000), seconds-from-now, or ISO 8601 / HTTP-date. `Retry-After` is parsed as seconds or date.

---

## Invocation Parameters

Cross-provider knobs merged into HTTP request bodies:

```typescript
interface ModelInvocationParams {
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: { enabled: boolean; budgetTokens?: number };
  reasoningEffort?: string; // OpenAI-style reasoning_effort
  thinkingFormat?: "native" | "xml-tags" | "none";
  requestExtras?: Record<string, unknown>; // Escape hatch: shallow-merged into request body
}
```

### Merge Hierarchy

1. `models.defaultInvocation` (config-level defaults)
2. `sessions.model_selection` (per-session overrides, session wins per field)
3. Subagent spawn: parent `model_selection` + `model_options` overlay (see [Daemon — Subagents](daemon.md#subagents))

```typescript
// Config + session merge:
mergeModelInvocationParams(modelsConfig, sessionModelSelection)

// Overlay (e.g. compaction call):
mergeModelInvocationOverlay(base, overlay)

// Subagent spawn:
mergeSubagentSpawnModelSelection(parentSelection, modelOptions, modelRef?)
```

`parseModelInvocationFromUnknown(raw)` safely parses unknown JSON into `ModelInvocationParams`. Accepts `requestExtras` or `extraBody` as the escape-hatch key.

---

## Transcript Compaction

`compactTranscriptIfNeeded(messages, policy, client, options)` summarizes older messages to keep context manageable.

### Policy

```typescript
interface CompactionPolicy {
  preserveRecentMessages: number; // Non-system messages kept verbatim at the tail
  summaryMaxOutputTokens?: number; // Cap for the summarization call
}
```

### Algorithm

1. Split leading system messages (prefix) from the rest.
2. If `rest.length <= preserveRecentMessages`, no compaction needed.
3. Split rest into `middle` (to summarize) and `tail` (to preserve).
4. If a previous `<summary>` block exists in the transcript, merge with it (incremental summarization).
5. Call `client.complete()` with a summarizer prompt (temperature 0.2).
6. Return `[...prefix, summaryBlock, ...tail]` where `summaryBlock` is an assistant message wrapping `<summary>...</summary>`.

### Summary Template

First compaction uses a structured template with sections: Goal, Constraints/Preferences, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context, Opaque Identifiers.

Subsequent compactions merge into the previous summary.

The summarizer is instructed to preserve all opaque identifiers exactly (UUIDs, hashes, URLs, file names, etc.).

---

## Image Codec

Provider-agnostic image handling via `ImageBlockCodec`:

```typescript
interface ImageBlockCodec {
  encode(block: ImageBlock): unknown; // Canonical → provider wire format
  decode(part: unknown): ImageBlock | null; // Provider wire → canonical
  readonly supportsUrl: boolean;
  readonly supportsImageInput: boolean;
}
```

### Canonical Format

```typescript
interface ImageBlock {
  type: "image";
  mediaType: string; // e.g. "image/jpeg", "image/png"
  base64?: string; // Raw bytes, base64-encoded
  url?: string; // Source URL
}
```

### Per-Provider Codecs

| Provider           | Codec                      | URL Support      | Wire Format                                                         |
| ------------------ | -------------------------- | ---------------- | ------------------------------------------------------------------- |
| OpenAI-Compatible  | `openaiImageBlockCodec`    | Yes              | `{ type: "image_url", image_url: { url } }` (data URI or plain URL) |
| Anthropic Messages | `anthropicImageBlockCodec` | Yes              | `{ type: "image", source: { type: "base64" \| "url", ... } }`       |
| Gemini             | `geminiImageBlockCodec`    | No (base64 only) | `{ inlineData: { mimeType, data } }`                                |

`getImageBlockCodec(kind)` returns the codec by provider kind.

`wrapCodecWithCapabilities(codec, capabilities)` returns a codec that throws on `encode()` when `capabilities.imageInput === false`.

---

## Extended Thinking

Handles models that emit reasoning/thinking content alongside their response.

### Thinking Formats

| Format       | Behavior                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `"native"`   | Content returned unchanged (provider handles thinking natively, e.g. Anthropic `thinking` blocks) |
| `"xml-tags"` | `<thinking>...</thinking>` and `<think>...</think>` tags are extracted/stripped                   |
| `"none"`     | No thinking processing                                                                            |

### Functions

- `normalizeThinkingBlocks(content, format)` — returns `string` or `ChatContentPart[]` with separate `{ type: "thinking" }` parts when format is `"xml-tags"`.
- `extractXmlThinkingBlocks(content)` — parses XML thinking tags into structured content parts.
- `stripXmlThinkingTags(content)` — removes thinking tags entirely (used for cleaning tool call arguments that leak thinking).

### Streaming Normalization

`ThinkingStreamNormalizer` is a stateful streaming processor that buffers partial `<thinking>`/`<think>` tags character-by-character, emitting `{ text?, thinking? }` results per chunk. Used by all three providers during SSE consumption when `thinkingFormat === "xml-tags"`.

---

## Token Usage Tracking

All providers extract usage metadata when available:

```typescript
interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens?: number;
}
```

| Provider          | Input Source                                                           | Output Source                                      |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| OpenAI-Compatible | `usage.prompt_tokens`                                                  | `usage.completion_tokens`                          |
| Anthropic         | `message.usage.input_tokens` (from `message_start` event in streaming) | `usage.output_tokens` (from `message_delta` event) |
| Gemini            | `usageMetadata.promptTokenCount`                                       | `usageMetadata.candidatesTokenCount`               |

For streaming, usage is captured from the final chunk/event.

`estimateTranscriptChars(messages)` provides a quick character-count estimate of transcript size (not token-accurate, used for heuristics).

---

## Type Reference

### Message Types

```typescript
type ChatRole = "system" | "user" | "assistant" | "tool";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | ImageBlock;

interface ChatMessage {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ChatToolCall[];
}

interface ChatToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}
```

### Tool Definitions

```typescript
interface OpenAIToolFunctionDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}
```

### Error Type

```typescript
class ModelHttpError extends Error {
  readonly status: number;
  readonly bodySnippet?: string;
}
```

### Failover Output Types

```typescript
interface FailoverCompleteOutput extends ModelCompleteOutput {
  usedProviderId: string;
  usedModel: string;
  degraded: boolean; // true when a non-primary entry produced the response
  thinkingFormat?: "native" | "xml-tags" | "none";
}

interface FailoverToolCompleteOutput extends ModelToolCompleteOutput {
  usedProviderId: string;
  usedModel: string;
  degraded: boolean;
  thinkingFormat?: "native" | "xml-tags" | "none";
}
```

---

## Public Exports

All public API is re-exported from `src/index.ts`:

| Category          | Exports                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Providers         | `createOpenAICompatibleProvider`, `createAnthropicMessagesProvider`, `createGeminiProvider`                                                                                                                  |
| Failover          | `createFailoverModelClient`, `createFailoverToolCallingClient`                                                                                                                                               |
| Config            | `createFailoverClientFromModelsConfig`, `createFailoverToolCallingClientFromModelsConfig`, `resolveCompactionPolicyFromModelsConfig`                                                                         |
| Resilience        | `ModelResilienceGate`, `setResilienceGate`, `getResilienceGate`, `classifyModelError`, `DEFAULT_BACKOFF_CONFIG`, `computeBackoffDelay`, `BackoffState`, `parseRateLimitHeaders`, `ProviderResilienceManager` |
| Compaction        | `estimateTranscriptChars`, `compactTranscriptIfNeeded`                                                                                                                                                       |
| Invocation        | `mergeModelInvocationParams`, `mergeModelInvocationOverlay`, `mergeSubagentSpawnModelSelection`, `parseModelInvocationFromUnknown`                                                                           |
| Image             | `getImageBlockCodec`, `openaiImageBlockCodec`, `anthropicImageBlockCodec`, `geminiImageBlockCodec`, `wrapCodecWithCapabilities`                                                                              |
| Thinking          | `extractXmlThinkingBlocks`, `normalizeThinkingBlocks`                                                                                                                                                        |
| Errors            | `ModelHttpError`, `isFailoverEligibleError`                                                                                                                                                                  |
| Anthropic Helpers | `buildOpenAiToAnthropicToolNameMap`, `consumeAnthropicMessagesStream`, `mapChatMessagesToAnthropicPayload`, `normalizeAnthropicMessagesOrigin`, `normalizeAnthropicWireModelId`                              |
| Gemini Helpers    | `consumeGeminiStream`, `mapChatMessagesToGeminiPayload`                                                                                                                                                      |

---

## See Also

- [Daemon](daemon.md) — consumes this package for agent turns, compaction, and health probes
- [Shared](shared.md) — `ShoggothModelsConfig` schema and invocation param types
- [MCP Integration](mcp-integration.md) — tool catalog that feeds into model tool calls
