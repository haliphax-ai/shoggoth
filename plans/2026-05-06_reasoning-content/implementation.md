# Implementation

## Phase 1: Type changes in `@shoggoth/models`

Add `reasoningContent` field to `ChatMessage`, `ModelToolCompleteOutput`, and the streaming return type.

- `packages/models/src/types.ts` — add `reasoningContent?: string` to `ChatMessage` and `ModelToolCompleteOutput`
- `packages/models/src/tool-failover.ts` — `FailoverToolCompleteOutput` inherits from `ModelToolCompleteOutput`, already covers it

**Files:**

- `packages/models/src/types.ts`

## Phase 2: Response parsing in OpenAI-compatible provider

Capture `reasoning_content` from both streaming and non-streaming responses. Return it alongside content.

**Streaming (`consumeOpenAIChatCompletionStream`):**

- Add `reasoningBuf` variable (string accumulator, capped at `MAX_REASONING_CONTENT_BYTES`)
- In `processDataPayload`, extract `(delta as any).reasoning_content` if present and accumulate
- Include `reasoningContent` in the return value

**Non-streaming (`complete` and `completeWithTools`):**

- After parsing `choices[0].message`, extract `message.reasoning_content`
- Return it as `reasoningContent` in the output

**Files:**

- `packages/models/src/openai-compatible.ts`

## Phase 3: Wire serialization in OpenAI-compatible provider

Update `serializeChatMessage` to accept an options parameter for thinking format, and emit `reasoning_content` when the format is `"native"` (default) and `reasoningContent` is set on the message.

Propagate the thinkingFormat through the call chain: `complete`/`completeWithTools` → `serializeChatMessage`.

**Files:**

- `packages/models/src/openai-compatible.ts`

## Phase 4: Transcript storage and loading

**Storage (`tool-loop.ts`):**
When the model returns `out.reasoningContent`, store it in the metadata of the assistant transcript row.

**Loading (`transcript-to-chat.ts`):**
When reconstructing `ChatMessage` from transcript rows, read `reasoningContent` from `metadata_json` and set it on the message.

**Files:**

- `packages/daemon/src/sessions/tool-loop.ts`
- `packages/daemon/src/sessions/transcript-to-chat.ts`

## Phase 5: Tool loop model client passthrough

The `session-tool-loop-model-client.ts` currently stores assistant messages in the `messages` array. Ensure `reasoningContent` from `out` is included on the stored `ChatMessage`. This is a one-line addition in the `complete()` method — the `ChatMessage` pushed to the messages array needs `reasoningContent: out.reasoningContent` when present.

Also ensure `pushToolMessage` does NOT strip reasoning content from prior messages (it doesn't touch existing messages, so this should already be correct).

**Files:**

- `packages/daemon/src/sessions/session-tool-loop-model-client.ts`

## Phase 6: Unit tests

**OpenAI-compatible provider tests:**

- Non-streaming response with `reasoning_content` → output has `reasoningContent`
- Streaming response with `reasoning_content` deltas → accumulated correctly
- Empty/null `reasoning_content` → no `reasoningContent` on output
- `serializeChatMessage` with `thinkingFormat: "native"` and `reasoningContent` set → wire has `reasoning_content`
- `serializeChatMessage` with `thinkingFormat: "xml-tags"` and `reasoningContent` set → wire does NOT have `reasoning_content`
- `serializeChatMessage` without `reasoningContent` → no `reasoning_content` on wire

**Transcript round-trip tests:**

- Loading transcript row with `reasoningContent` in metadata → ChatMessage has `reasoningContent`
- Loading transcript row without `reasoningContent` → ChatMessage has no `reasoningContent`

**Files:**

- `packages/models/test/openai-compatible.test.ts`
- `packages/daemon/test/sessions/transcript-to-chat.test.ts` (create if needed)
