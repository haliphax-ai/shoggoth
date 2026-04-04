---
date: 2026-04-04
completed: never
---

# Thinking block normalization — per-model extraction and canonicalization

## Summary

Normalize model thinking/reasoning output into canonical `ChatContentPart` blocks regardless of how the underlying model emits them. Models like GLM-5 dump raw `<thinking>...</thinking>` XML tags into their text response, which interferes with tool call parsing and corrupts transcripts. Models like Claude and Gemini return structured thinking natively. A shared normalization layer, driven by per-model capability config, extracts and canonicalizes thinking before it reaches the tool loop or transcript.

## Motivation

GLM-5 served through kiro-gateway (an Anthropic-compatible proxy) emits `<thinking>` XML tags inline in its response content. The Anthropic adapter doesn't expect this — it treats the entire content as text. When the model interleaves thinking with tool calls, the XML parser misinterprets boundaries, producing tool calls where the tool name is the model's reasoning text (e.g., `thinking>\nThe subagent approach failed...`). These malformed tool calls get stored in the transcript and poison every subsequent model request with 400 errors.

The tool name validation guard (commit `3948389`) catches the symptom, but the root cause is that thinking content isn't being separated from actionable content before parsing. Native thinking providers (Anthropic, OpenAI, Gemini) don't have this problem because thinking arrives in its own structured block. The gap is models that produce thinking as raw text.

## Design

### Capability: `thinkingFormat`

Add `thinkingFormat` to model capabilities, configurable per failover hop:

```ts
interface ModelCapabilities {
  imageInput?: boolean;
  thinkingFormat?: "native" | "xml-tags" | "none";
}
```

- `"native"` — Provider returns structured thinking blocks. No extraction needed. (Claude, o-series, Gemini 2.5)
- `"xml-tags"` — Model emits `<thinking>...</thinking>` tags in content. Extraction required.
- `"none"` (default when omitted) — Model doesn't produce thinking. No processing.

Config example:

```json
{
  "models": [
    {
      "provider": "kiro",
      "model": "default",
      "capabilities": { "thinkingFormat": "native" }
    },
    {
      "provider": "kiro",
      "model": "glm-5",
      "capabilities": { "thinkingFormat": "xml-tags" }
    }
  ]
}
```

### Extraction function

A shared utility that runs after the provider adapter returns the raw response but before content reaches the tool loop:

```ts
function normalizeThinkingBlocks(
  content: string,
  format: "native" | "xml-tags" | "none",
): string | ChatContentPart[] {
  if (format !== "xml-tags") return content;
  return extractXmlThinkingBlocks(content);
}
```

`extractXmlThinkingBlocks` splits the content string into an ordered array of `{ type: "thinking", text }` and `{ type: "text", text }` parts by matching `<thinking>...</thinking>` tags. If no thinking tags are found, returns the original string unchanged.

```ts
function extractXmlThinkingBlocks(content: string): string | ChatContentPart[] {
  const regex = /<thinking>([\s\S]*?)<\/thinking>/g;
  if (!regex.test(content)) return content;
  regex.lastIndex = 0;

  const parts: ChatContentPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index).trim();
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "thinking", text: match[1].trim() });
    lastIndex = regex.lastIndex;
  }

  const after = content.slice(lastIndex).trim();
  if (after) parts.push({ type: "text", text: after });

  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}
```

### Where in the pipeline

The normalization runs in each provider adapter's response parsing, after the raw response is received but before the content is returned to the caller. Each adapter calls `normalizeThinkingBlocks(content, capabilities.thinkingFormat)`.

This is adapter-agnostic — the same function is called from `anthropic-messages.ts`, `openai-compatible.ts`, and `gemini.ts`. The adapter passes the model's capabilities (from the failover hop config) to the function.

### Streaming

For streaming responses, thinking tags can span multiple chunks. The adapter needs a small state machine:

1. Buffer text when `<` is encountered
2. If the buffer matches `<thinking>`, enter thinking mode — accumulate content until `</thinking>`
3. If the buffer doesn't match a thinking tag, flush it as regular text
4. On stream end, flush any remaining buffer

This is bounded complexity — the state machine has three states: `text`, `buffering-tag`, `in-thinking`. The buffer is only needed for the tag detection window (max ~11 chars for `</thinking>`).

### Transcript storage

Thinking blocks are stored in the transcript as part of the serialized `ChatContentPart[]` (same as image blocks). When replayed to the model on subsequent turns:

- **Native thinking providers** (Claude): thinking blocks are stripped before replay. Anthropic's API doesn't accept previous thinking in input messages.
- **XML-tags providers** (GLM-5): thinking blocks can be stripped or re-serialized as `<thinking>...</thinking>` tags. Stripping is safer — the model doesn't need to see its own previous reasoning.
- **Default behavior**: strip thinking blocks from transcript replay regardless of provider. The model's thinking is observational, not conversational.

This reuses the same `sanitizeTranscriptForProvider` pattern from the `show` tool plan — a pass that strips content parts by type based on provider capabilities.

### Edge cases

- **Malformed tags**: unclosed `<thinking>` without `</thinking>` — treat everything after the open tag as thinking until end of content. Log a warning.
- **Nested tags**: `<thinking>...<thinking>...</thinking>...</thinking>` — the regex handles this via non-greedy matching. Inner tags are treated as text within the thinking block.
- **Empty thinking blocks**: `<thinking></thinking>` — skip, don't create an empty content part.
- **No thinking tags in xml-tags mode**: return content as-is (string, not array). No unnecessary wrapping.
- **Mixed content**: `text <thinking>reason</thinking> more text <tool_call>...` — the thinking is extracted, leaving clean text and tool call XML for the parser.
- **Thinking tags in tool results**: don't extract. Only process assistant message content.

## Implementation Phases

### Phase 1: Schema and capability plumbing

Add `thinkingFormat` to `ModelCapabilities` in types and to `ShoggothModelFailoverHop` in the config schema. Wire it through the failover chain so each hop's capabilities are available to the adapter.

**Files:**
- `packages/models/src/types.ts` — add `thinkingFormat` to `ModelCapabilities`
- `packages/shared/src/schema.ts` — add `thinkingFormat` to hop capabilities schema
- `packages/models/src/failover.ts` — ensure capabilities propagate to the active provider

### Phase 2: Extraction utility

Implement `normalizeThinkingBlocks` and `extractXmlThinkingBlocks` as a shared utility in the models package.

**Files:**
- `packages/models/src/thinking-normalize.ts` — new: extraction functions
- `packages/models/test/thinking-normalize.test.ts` — new: unit tests for extraction edge cases

### Phase 3: Adapter integration (non-streaming)

Wire the normalization into each adapter's response parsing for non-streaming completions.

**Files:**
- `packages/models/src/anthropic-messages.ts` — call normalization on assistant content
- `packages/models/src/openai-compatible.ts` — call normalization on assistant content
- `packages/models/src/gemini.ts` — call normalization on assistant content

### Phase 4: Streaming support

Add the tag-detection state machine for streaming responses. Each adapter's streaming path buffers and normalizes thinking tags as chunks arrive.

**Files:**
- `packages/models/src/thinking-normalize.ts` — add `ThinkingStreamNormalizer` class
- `packages/models/src/anthropic-messages.ts` — integrate stream normalizer
- `packages/models/src/openai-compatible.ts` — integrate stream normalizer
- `packages/models/src/gemini.ts` — integrate stream normalizer

### Phase 5: Transcript replay stripping

Strip thinking blocks from transcript messages before replaying to the model, regardless of provider. Extend the `sanitizeTranscriptForProvider` pass (from the `show` tool plan) or add a parallel pass.

**Files:**
- `packages/daemon/src/sessions/transcript-to-chat.ts` — strip thinking blocks on replay
- `packages/daemon/src/sessions/transcript-compact.ts` — strip thinking blocks before compaction summarization

## Testing Strategy

- **Extraction**: content with single/multiple/nested/unclosed/empty thinking tags all produce correct `ChatContentPart[]`. Content without thinking tags returns the original string. Only assistant content is processed.
- **Streaming**: thinking tags spanning multiple chunks are correctly buffered and extracted. Partial tags at chunk boundaries don't corrupt output. Stream end flushes remaining buffer.
- **Adapter integration**: GLM-5 response with `<thinking>` tags produces canonical thinking content parts. Claude response with native thinking passes through unchanged. Model with `thinkingFormat: "none"` is not processed.
- **Transcript replay**: thinking blocks are stripped from all roles before model call. Compaction strips thinking before summarization.
- **Config propagation**: `thinkingFormat` from hop config reaches the adapter via capabilities. Per-model override takes precedence over provider default.

## Considerations

- **Performance**: the regex scan adds negligible overhead for non-streaming. For streaming, the state machine adds a small per-chunk cost but avoids buffering entire responses.
- **Future providers**: new providers that use different thinking formats (e.g., `<reasoning>` tags, `[thinking]` markers) can be added as new `thinkingFormat` values with corresponding extractors.
- **Token estimation**: thinking tokens should be counted separately from content tokens for usage tracking. This is deferred but the content part separation makes it straightforward later.
- **User visibility**: thinking blocks are internal model behavior, not shown to the user. Platform adapters should strip thinking parts from outbound messages. This is already handled by the text-only reply path.
- **Interaction with tool name validation**: the tool name validation guard (`VALID_TOOL_NAME` regex) remains as a safety net even after thinking normalization is implemented. Defense in depth.

## Migration

No schema migration required. The `thinkingFormat` capability is optional and defaults to `"none"`. Existing configurations are unaffected. Adding `thinkingFormat: "xml-tags"` to a hop is a config-only change.
