---
date: 2026-05-06
completed: never
---

# OpenAI `reasoning_content` — capture and echo-back for native reasoning models

## Summary

Capture native `reasoning_content` from OpenAI-compatible API responses and echo it back on subsequent requests to the same (or compatible) model. This fixes 400 errors from providers like SiliconFlow (and potentially other OpenRouter-backed reasoning models) that require `reasoning_content` to be passed back verbatim for conversation continuity.

## Motivation

DeepSeek v4 Flash and similar reasoning models served through OpenAI-compatible APIs (OpenRouter → SiliconFlow, etc.) emit a `reasoning_content` field on the assistant message alongside the regular `content`. The API requires this field to be echoed back in subsequent requests — omitting it produces:

```
400: The `reasoning_content` in the thinking mode must be passed back to the API.
```

Currently, the OpenAI-compatible adapter:

1. **Ignores `reasoning_content`** on response parsing (both streaming and non-streaming)
2. **Strips thinking content parts** from the transcript on replay (`stripThinkingBlocks`)
3. **Serializes thinking parts as empty text blocks** (`serializeContentParts`: `{ type: "text", text: "" }`)

The result: `reasoning_content` is completely lost between turns. Every request after the first that triggers reasoning fails.

This is distinct from the existing XML-tags thinking normalization (`<thinking>...</thinking>`). The `reasoning_content` field is a _native_ OpenAI API feature (used by DeepSeek, o-series models, and compatible providers). It must be preserved verbatim at the wire level, not extracted as XML.

## Design

### Approach

Add an optional `reasoningContent` string field to `ChatMessage` at the canonical model type layer, and thread it through the response → storage → replay pipeline. The field is only populated when the provider's `thinkingFormat` is `"native"` (the default for OpenAI-compatible reasoning models) and the API response includes `reasoning_content`.

### Data flow

```
Provider API response            Transcript                         Next request
┌─────────────────┐             ┌──────────────┐                   ┌─────────────────────┐
│ message.content  │──────────→ │ content       │ ────[load]────→ │ message.content      │
│ message.reasoning│─────┐      │ metadata_json │                  │ message.reasoning    │
│       _content   │     │      │ { "reasoning  │                  │       _content       │
└─────────────────┘     │      │   Content":... }│                 └─────────────────────┘
                        └────→ └──────────────┘                           ▲
                              (transcript.append)                         │
                                                                          │
                              ┌──────────────────────┐                    │
                              │ Tool loop model      │ ──────────────────┘
                              │ client (same turn)   │
                              │ → ChatMessage with   │
                              │   reasoningContent    │
                              └──────────────────────┘
```

1. **Response parsing** (provider adapter): Extract `reasoning_content` from `choices[0].message` (non-streaming) or `delta.reasoning_content` (streaming). Return it alongside content in `ModelToolCompleteOutput.reasoningContent`.

2. **Failover pass-through**: `FailoverToolCompleteOutput` and the client chain propagate the field unchanged.

3. **Tool loop model client** (`session-tool-loop-model-client.ts`): Store `reasoningContent` on the `ChatMessage` added to the messages array. Within the same turn, this preserves reasoning content for subsequent `complete()` calls.

4. **Transcript storage** (`tool-loop.ts` / `transcript-store.ts`): Store `reasoningContent` inside the `metadata_json` column (as `{ reasoningContent: "..." }`). No schema migration needed.

5. **Transcript loading** (`transcript-to-chat.ts`): Read `reasoningContent` from metadata and set it on the reconstructed `ChatMessage`.

6. **Request serialization** (`openai-compatible.ts`, `serializeChatMessage`): When `message.reasoningContent` is set and the current thinking format is `"native"`, emit it as `reasoning_content` on the wire message object.

### Key decisions

| Decision                                          | Rationale                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store in `metadata_json` not a new column         | Avoids schema migration. Metadata is already used for various annotations. Minimal code churn.                                                                                                                                                                                     |
| Separate field, not `ChatContentPart[]` extension | ChatContentParts get JSON-stringified in the tool loop model client, losing type info. A dedicated string field avoids that. `thinking` parts (from xml-tags) and `reasoningContent` (native) are semantically different — the former is stripped on replay, the latter preserved. |
| Only serialize when `thinkingFormat === "native"` | For `xml-tags` providers, thinking content in the message would have come from XML tag extraction, not the native API field. Those providers don't understand `reasoning_content`. For `"none"`, don't send it.                                                                    |
| Failover pass-through                             | Ensures reasoning content survives provider failover within a turn (the messages array is shared, so the reasoning content persists regardless of which provider produced it).                                                                                                     |

### Edge cases

- **Streaming + non-streaming**: Both paths must capture and return `reasoningContent`. Streaming accumulates `delta.reasoning_content` across chunks.
- **Empty reasoning_content**: If `reasoning_content` is `null` or `""`, don't set `reasoningContent` on the output. No unnecessary empty string in transcript.
- **Both content and reasoning_content null**: Handle gracefully — don't set reasoningContent if there's no assistant content either.
- **Multiple providers in failover chain**: Reasoning content from one provider is still in the messages array and will be serialized for the next provider. This is fine — if the fallback provider doesn't support reasoning_content, it will just be ignored. If it does, it's needed.
- **Within-turn vs between-turn**: Within-turn (same tool loop), `reasoningContent` is in the in-memory ChatMessage. Between-turn (loaded from transcript), it's read from metadata. Both paths covered.

## Testing Strategy

- Unit test: non-streaming response with `reasoning_content` produces `reasoningContent` in output
- Unit test: streaming response with `reasoning_content` deltas accumulates correctly per-chunk
- Unit test: `serializeChatMessage` emits `reasoning_content` on wire message only when `thinkingFormat === "native"`
- Unit test: `serializeChatMessage` does NOT emit `reasoning_content` when `thinkingFormat === "xml-tags"` or `"none"`
- Unit test: transcript load with `reasoningContent` in metadata reconstructs ChatMessage correctly
- Unit test: tool loop model client stores and forwards `reasoningContent` between calls within same turn
- Integration test (manual): request to DeepSeek v4 Flash through OpenRouter → SiliconFlow does not produce 400 error on second turn

## Considerations

- **XML-tags thinking vs native reasoning**: The existing `type: "thinking"` ChatContentPart from XML-tag extraction is a separate concern. This fix does not change that behavior — XML-tag thinking parts continue to be stripped on replay. The new `reasoningContent` field is for native API reasoning content only.
- **Gemini thought signatures**: Gemini has its own `thoughtSignature` on tool calls. That's already handled separately. No conflict.
- **Anthropic thinking blocks**: Anthropic uses a native `thinking` content block type, not `reasoning_content`. The Anthropic adapter handles that natively. No changes needed there.
- **Within-turn parsing**: The tool loop model client stores `out.content` as a string. If we embed reasoning_content inside ChatGPTContentPart[] and JSON.stringify it, within-turn parsing would see a JSON string, not an array. Using a separate string field avoids this entirely.
- **Metadata bloat**: `reasoningContent` in metadata adds to row size. Reasonable upper bound for reasoning content is similar to content (potentially thousands of tokens). This is acceptable — the metadata column already carries variable-size payloads.

## Migration

No schema migration required. Existing `transcript_messages` rows without `reasoningContent` in metadata work fine — the field simply won't be present on the loaded ChatMessage.

No config changes needed. The `thinkingFormat` parameter already exists and defaults to `"none"`. Providers that want reasoning_content echo-back need to set `thinkingFormat: "native"` on their failover hop.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
