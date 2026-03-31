# Plan: `gemini` model provider type

Add a first-class `gemini` provider kind to `@shoggoth/models`, encapsulating Google's Gemini REST API behind the existing `ModelProvider` interface. Same pattern as the `anthropic-messages` provider addition.

## Why not `openai-compatible`?

Google offers an OpenAI-compatible shim, but it has known issues (missing `index` on streamed tool call deltas, different error shapes) and doesn't expose Gemini-specific features. The native REST API deviates from both OpenAI and Anthropic in several structural ways that warrant their own provider.

## Key deviations from OpenAI / Anthropic

| Concern | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| Endpoint | `POST {base}/chat/completions` | `POST {origin}/v1/messages` | `POST {base}/v1beta/models/{model}:generateContent` (non-stream) / `:streamGenerateContent?alt=sse` (stream) |
| Model location | Request body `model` field | Request body `model` field | URL path segment |
| Auth header | `Authorization: Bearer` | `x-api-key` (or Bearer) | `x-goog-api-key` |
| Message format | `messages[]` with `role`+`content` | `messages[]` with content blocks; system extracted | `contents[]` with `role` (`user`/`model`/`tool`) + `parts[]` array |
| System prompt | `role: "system"` message | Top-level `system` field | `systemInstruction` field (top-level) |
| Tool definitions | `tools[].function` | `tools[].name`+`input_schema` | `tools[].function_declarations[]` (nested array) |
| Tool call response | `tool_calls[]` on assistant message | `tool_use` content blocks | `functionCall` parts on model message |
| Tool results | `role: "tool"` message with `tool_call_id` | `tool_result` content blocks in user turn | `role: "tool"` with `functionResponse` parts (name + response object) |
| Generation params | Top-level `temperature`, `max_tokens` | Top-level `temperature`, `max_tokens` | Nested under `generationConfig` (`temperature`, `maxOutputTokens`, `topP`, `topK`) |
| Streaming format | `data: {choices[].delta}` SSE | Anthropic SSE events (`content_block_delta`, etc.) | `data: {candidates[].content.parts}` SSE (each chunk is a `GenerateContentResponse`) |
| Stream termination | `data: [DONE]` | `message_stop` event | Stream ends (no explicit DONE sentinel) |
| Safety | N/A | N/A | `safetySettings[]` array; responses include `safetyRatings` and can be blocked with `finishReason: "SAFETY"` |
| Function call IDs | Always present (`tool_calls[].id`) | Always present (`tool_use` block `id`) | Present on Gemini 2.0+ (`functionCall.id`); should be synthesized if absent for older models |

## Scope

### New files

- `packages/models/src/gemini.ts` — provider factory + streaming consumer
- `packages/models/test/gemini.test.ts` — unit tests (same style as `anthropic-messages.test.ts`)

### Modified files

- `packages/shared/src/schema.ts` — add `shoggothGeminiProviderSchema` to the `shoggothModelProviderEntrySchema` discriminated union (`kind: "gemini"`)
- `packages/models/src/from-config.ts` — add `gemini` branch in `modelProvidersById`
- `packages/models/src/index.ts` — re-export factory + types
- `docs/models.md` — document the new provider kind

### Not in scope (this pass)

- Vertex AI auth (OAuth2 / service account) — API key only for now; Vertex can be a follow-up
- Multimodal input (images/audio/video parts) — text + tool calling only
- Safety settings configuration — use Google defaults; expose later via `requestExtras` escape hatch
- Google Search grounding / code execution tools — Gemini-specific tool types beyond function calling
- Gemini thinking/reasoning budget — can be added later similar to Anthropic `thinking` support

## Config schema

```typescript
const shoggothGeminiProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("gemini"),
  /** API origin, e.g. "https://generativelanguage.googleapis.com". */
  baseUrl: z.string().min(1).default("https://generativelanguage.googleapis.com"),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  /** API version path segment. Default "v1beta". */
  apiVersion: z.string().min(1).optional(),
}).strict();
```

Example config:

```json
{
  "models": {
    "providers": [
      {
        "id": "gemini",
        "kind": "gemini",
        "apiKeyEnv": "GEMINI_API_KEY"
      }
    ],
    "failoverChain": [
      { "providerId": "gemini", "model": "gemini-2.5-flash" }
    ]
  }
}
```

## Provider factory signature

```typescript
export interface GeminiProviderOptions {
  readonly id: string;
  readonly baseUrl?: string;  // default: "https://generativelanguage.googleapis.com"
  readonly apiKey?: string;
  readonly apiVersion?: string;  // default: "v1beta"
  readonly fetchImpl?: FetchLike;
}

export function createGeminiProvider(options: GeminiProviderOptions): ModelProvider;
```

## Message mapping (`ChatMessage[]` → Gemini `contents`)

1. Collect all `role: "system"` messages → concatenate into `systemInstruction.parts[].text`
2. Map `role: "user"` → `{ role: "user", parts: [{ text }] }`
3. Map `role: "assistant"` →
   - Text content → `{ role: "model", parts: [{ text }] }`
   - Tool calls → `{ role: "model", parts: [{ functionCall: { name, args, id? } }] }`
   - Both → single model message with mixed parts
4. Map consecutive `role: "tool"` messages → `{ role: "tool", parts: [{ functionResponse: { name, response: { content } } }] }` (batch into one turn, similar to Anthropic `tool_result` batching)

## Response parsing

### Non-streaming

Parse `candidates[0].content.parts[]`:
- `text` parts → concatenate into `content`
- `functionCall` parts → map to `ChatToolCall[]` (synthesize IDs if missing)

Handle `finishReason: "SAFETY"` as a `ModelHttpError` (could use 400 or a custom code).

### Streaming

Consume SSE from `streamGenerateContent?alt=sse`:
- Each `data:` line is a full `GenerateContentResponse` JSON
- Accumulate `text` parts, fire `onTextDelta` callbacks
- Accumulate `functionCall` parts for tool calling
- No `[DONE]` sentinel; stream simply ends

## `ModelInvocationParams` mapping

| Shoggoth param | Gemini `generationConfig` field |
|---|---|
| `maxOutputTokens` | `maxOutputTokens` |
| `temperature` | `temperature` |
| `requestExtras` | Shallow-merged into request body (escape hatch for `safetySettings`, `topP`, `topK`, etc.) |
| `thinking` | Not mapped initially (Gemini has its own thinking model variants) |
| `reasoningEffort` | Not mapped initially |

## Environment fallback

Add to `singleHopFromEnv` in `from-config.ts`:

```
GEMINI_BASE_URL → baseUrl (optional, defaults to googleapis)
GEMINI_API_KEY → apiKey
```

Priority order: Anthropic (if `ANTHROPIC_BASE_URL` set) → Gemini (if `GEMINI_API_KEY` set) → OpenAI (default).

## Test strategy

Same approach as `anthropic-messages.test.ts`:
- Mock `fetchImpl` to return canned Gemini responses
- Test message mapping (system extraction, tool call round-trips, consecutive tool results batching)
- Test streaming consumer (happy path, safety block, malformed chunks)
- Test tool name pass-through (Gemini doesn't have Anthropic's name restrictions, so no sanitization needed — but verify round-trip fidelity)
- Test missing function call IDs (synthesize them)
- Test error responses (4xx, 5xx, safety blocks)

## Rollout

1. Implement `gemini.ts` + tests
2. Wire into schema + `from-config.ts`
3. Update `docs/models.md`
4. Test with real Gemini API key in readiness suite
5. Follow-up: Vertex AI auth, safety settings config, thinking support
