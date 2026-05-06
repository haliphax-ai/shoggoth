# Specification

## Interfaces

### Modified: `ChatMessage`

```ts
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content?: string | ChatContentPart[] | null;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ChatToolCall[];
  /** Native reasoning content from OpenAI-compatible APIs (e.g., DeepSeek reasoning_content).
   *  Only meaningful when thinkingFormat is "native". This is NOT XML-tags thinking —
   *  it's the raw API-level reasoning_content field that must be echoed back. */
  readonly reasoningContent?: string;
}
```

### Modified: `ModelToolCompleteOutput`

```ts
export interface ModelToolCompleteOutput {
  readonly content: string | null;
  readonly toolCalls: readonly ChatToolCall[];
  readonly usage?: ModelUsage;
  /** Raw reasoning_content from the provider response. */
  readonly reasoningContent?: string;
}
```

### Modified: `FailoverToolCompleteOutput`

```ts
export type FailoverToolCompleteOutput = ModelToolCompleteOutput & {
  readonly usedProviderId: string;
  readonly usedModel: string;
  readonly degraded: boolean;
  readonly thinkingFormat?: "native" | "xml-tags" | "none";
};
```

(`reasoningContent` is inherited from `ModelToolCompleteOutput` — no additional field needed.)

## Function Signatures

### Streaming accumulation constant

```ts
/** Maximum accumulated reasoning_content to buffer in streaming (200KB). */
const MAX_REASONING_CONTENT_BYTES = 200_000;
```

### `openai-compatible.ts` — internal changes

```ts
// In consumeOpenAIChatCompletionStream return type:
Promise<{
  content: string | null;
  toolCalls: ChatToolCall[];
  reasoningContent?: string;
  usage?: ModelUsage;
}>;

// In processDataPayload:
const d = delta as { content?: unknown; tool_calls?: unknown; reasoning_content?: string };
// ... existing content handling ...
if (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) {
  const accumulated = reasoningBuf + d.reasoning_content;
  if (accumulated.length <= MAX_REASONING_CONTENT_BYTES) {
    reasoningBuf = accumulated;
  }
}
```

### `serializeChatMessage` — wire format with reasoning content

```ts
function serializeChatMessage(
  m: ChatMessage,
  options?: { thinkingFormat?: "native" | "xml-tags" | "none" },
): Record<string, unknown> {
  const o: Record<string, unknown> = { role: m.role };
  // ... existing tool call serialization ...

  // Native reasoning content: emit as reasoning_content on the wire
  if (
    m.reasoningContent &&
    (options?.thinkingFormat === "native" || options?.thinkingFormat === undefined)
  ) {
    o.reasoning_content = m.reasoningContent;
  }

  // ... existing content serialization ...
  return o;
}
```

### `transcript-to-chat.ts` — metadata key

```ts
/** Key used in transcript metadata for native reasoning content. */
const REASONING_META_KEY = "reasoningContent";
```

## Data Structures

### Transcript metadata shape (stored in `metadata_json` column)

```jsonc
{
  // ... existing metadata fields ...
  "reasoningContent": "Let me analyze the user's request step by step...", // optional
}
```

## Code Examples

### Non-streaming response parsing

```ts
// In completeWithTools, after parsing choices[0].message:
const message = ...; // parsed JSON message object
let reasoningContent: string | undefined;
if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
  reasoningContent = message.reasoning_content;
}

return {
  content: finalContent,
  toolCalls,
  usage: extractOpenAIUsage(json),
  reasoningContent,
};
```

### Streaming response parsing

```ts
// In processDataPayload within consumeOpenAIChatCompletionStream:
let reasoningBuf = "";
// ... inside the delta handler:
if (typeof (delta as any).reasoning_content === "string") {
  const chunk = (delta as any).reasoning_content;
  if (chunk.length > 0) {
    const next = reasoningBuf + chunk;
    if (next.length <= MAX_REASONING_CONTENT_BYTES) {
      reasoningBuf = next;
    }
  }
}
```

### Wire request serialization

```ts
const m: ChatMessage = {
  role: "assistant",
  content: "The answer is 42.",
  reasoningContent: "The user asked a simple question...",
};

const wire = serializeChatMessage(m, { thinkingFormat: "native" });
// wire.reasoning_content === "The user asked a simple question..."
```

### Transcript round-trip

```ts
// Storing:
transcript.append({
  sessionId,
  contextSegmentId,
  role: "assistant",
  content: "The answer is 42.",
  metadata: { reasoningContent: "The user asked..." },
});

// Loading (in transcript-to-chat.ts):
const meta = m.metadata as Record<string, unknown> | undefined;
const reasoningContent =
  typeof meta?.["reasoningContent"] === "string" ? meta["reasoningContent"] : undefined;
```
