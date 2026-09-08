# Specification

## Interfaces

### `OutOfBandResponseWithSender`

For subagent result delivery — the parent session needs to reply to both the operator and the originating subagent.

```ts
interface OutOfBandResponseWithSender {
  /** Message to deliver to the operator's channel. Null = nothing to show. */
  to_operator: string | null;
  /** Message to send back to the subagent/sender session. Null = nothing to send back. */
  to_sender: string | null;
}
```

### `OutOfBandResponseNoSender`

For timer/cron delivery — no originating session to reply to.

```ts
interface OutOfBandResponseNoSender {
  /** Message to deliver to the operator's channel. Null = nothing to show. */
  to_operator: string | null;
}
```

### Updated `SubagentRuntimeExtension`

Add `modelInvocationOverride` support. The existing type in `packages/daemon/src/subagent/subagent-extension-ref.ts` gains an optional field on the `runSessionModelTurn` input:

```ts
// The input type for runSessionModelTurn already exists.
// Add this field to it:
interface RunSessionModelTurnInput {
  // ...existing fields...
  /** Optional override for model invocation params (e.g. responseSchema for structured output). */
  modelInvocationOverride?: Partial<ModelInvocationParams>;
}
```

### `ExecuteSessionAgentTurnInput` extension

The input type in `packages/daemon/src/sessions/session-agent-turn.ts` gains the same override:

```ts
interface ExecuteSessionAgentTurnInput {
  // ...existing fields...
  /** Optional override merged into the session's model invocation params before the turn. */
  modelInvocationOverride?: Partial<ModelInvocationParams>;
}
```

## API / Function Signatures

### `deliverOobStructuredResponse()`

New function in `packages/daemon/src/control/integration-ops.ts`. Parses a structured OOB response and routes fields to their destinations.

```ts
/**
 * Parse a structured out-of-band response and deliver fields to destinations.
 *
 * @param opts.structuredResponse - The raw JSON string from the model turn.
 * @param opts.respondTo - The session ID to deliver to_sender to (subagent results).
 * @param opts.childSessionId - The originating subagent session ID (for logging).
 * @param opts.ext - The SubagentRuntimeExtension for delivery methods.
 * @param opts.subLog - Logger instance.
 * @param opts.maxChars - Max characters for truncation (default: 8000).
 * @param opts.hasSender - Whether this response includes a to_sender field.
 */
async function deliverOobStructuredResponse(opts: {
  structuredResponse: string;
  respondTo: string;
  childSessionId?: string;
  ext: SubagentRuntimeExtension;
  subLog: Logger;
  maxChars?: number;
  hasSender: boolean;
}): Promise<void>;
```

### Updated `deliverSubagentResult()`

The existing function signature is unchanged, but its internal implementation gains the structured output path:

```ts
// Existing signature (no change):
export async function deliverSubagentResult(
  ext: SubagentRuntimeExtension,
  opts: {
    deliveryMode: DeliveryMode;
    childSessionId: string;
    respondTo: string;
    internalDelivery?: boolean;
    mode: "one_shot" | "persistent";
    assistantText: string;
    subLog: Logger;
    maxChars?: number;
  },
): Promise<void>;

// Internal change: the queue/fallback path now:
// 1. Sets modelInvocationOverride with OOB_SCHEMA_WITH_SENDER
// 2. Calls runSessionModelTurn (model produces structured JSON)
// 3. Calls deliverOobStructuredResponse() to parse and route
```

## Data Structures / Schemas

### `OOB_SCHEMA_WITH_SENDER`

JSON Schema for subagent result delivery (both `to_operator` and `to_sender`).

```json
{
  "type": "object",
  "properties": {
    "to_operator": {
      "type": ["string", "null"],
      "description": "Message to deliver to the operator's channel. Null = nothing to show."
    },
    "to_sender": {
      "type": ["string", "null"],
      "description": "Message to send back to the subagent/sender session. Null = nothing to send back."
    }
  },
  "required": ["to_operator", "to_sender"],
  "additionalProperties": false
}
```

### `OOB_SCHEMA_NO_SENDER`

JSON Schema for timer/cron delivery (only `to_operator`).

```json
{
  "type": "object",
  "properties": {
    "to_operator": {
      "type": ["string", "null"],
      "description": "Message to deliver to the operator's channel. Null = nothing to show."
    }
  },
  "required": ["to_operator"],
  "additionalProperties": false
}
```

### Context Guidance Strings

**Subagent result (with sender):**

```
This is an out-of-band message. Respond with structured output.
- to_operator: Message to surface to the operator (null = nothing to show)
- to_sender: Message to reply to the originating session (null = nothing to send back)
Either field may be null. The system handles delivery.
```

**Timer fire (no sender):**

```
This is an out-of-band message. Respond with structured output.
- to_operator: Message to surface to the operator (null = nothing to show)
The system handles delivery.
```

## Code Examples

### Schema injection in `deliverSubagentResult` (queue path)

```ts
// In the queue/fallback path of deliverSubagentResult:
const turn = await ext.runSessionModelTurn({
  sessionId: respondTo,
  userContent: baseContent, // no more asyncOnlyReminder
  userMetadata: { subagent_result: true, child_session_id: childSessionId, mode },
  systemContext: {
    kind: "subagent.result",
    summary: `Result delivered from subagent ${childSessionId}.`,
    data: { child_session_id: childSessionId, mode },
  },
  guidance: OOB_WITH_SENDER_GUIDANCE,
  delivery: { kind: "internal" },
  modelInvocationOverride: {
    responseSchema: OOB_SCHEMA_WITH_SENDER,
    structuredOutputMode: "best-effort",
  },
});

// Parse and deliver the structured response
await deliverOobStructuredResponse({
  structuredResponse: turn.latestAssistantText,
  respondTo,
  childSessionId,
  ext,
  subLog,
  hasSender: true,
});
```

### Schema injection in timer handler

```ts
// In packages/daemon/src/index.ts timer fire handler:
await ext.runSessionModelTurn({
  sessionId,
  userContent: timerContent,
  guidance: OOB_NO_SENDER_GUIDANCE,
  delivery: { kind: "internal" },
  modelInvocationOverride: {
    responseSchema: OOB_SCHEMA_NO_SENDER,
    structuredOutputMode: "best-effort",
  },
});

// Parse and deliver
await deliverOobStructuredResponse({
  structuredResponse: turn.latestAssistantText,
  respondTo: sessionId,
  ext,
  subLog: timerLog,
  hasSender: false,
});
```

### `deliverOobStructuredResponse` implementation sketch

```ts
async function deliverOobStructuredResponse(opts) {
  const {
    structuredResponse,
    respondTo,
    childSessionId,
    ext,
    subLog,
    maxChars = 8000,
    hasSender,
  } = opts;

  let parsed: Record<string, string | null>;
  try {
    parsed = JSON.parse(structuredResponse);
  } catch {
    subLog.warn("oob structured response parse failed", { structuredResponse });
    return;
  }

  // Deliver to operator
  if (parsed.to_operator && typeof parsed.to_operator === "string") {
    const truncated =
      parsed.to_operator.length > maxChars
        ? parsed.to_operator.slice(0, maxChars)
        : parsed.to_operator;
    if (ext.postToOperator) {
      await ext.postToOperator(respondTo, truncated);
    }
  }

  // Deliver to sender (subagent results only)
  if (hasSender && parsed.to_sender && typeof parsed.to_sender === "string") {
    const truncated =
      parsed.to_sender.length > maxChars ? parsed.to_sender.slice(0, maxChars) : parsed.to_sender;
    // Try inline steer first, fall back to queue
    if (!pushSteer(respondTo, truncated)) {
      await ext.runSessionModelTurn({
        sessionId: respondTo,
        userContent: truncated,
        delivery: { kind: "internal" },
      });
    }
  }
}
```

### `modelInvocationOverride` merge in `session-agent-turn.ts`

```ts
// In executeSessionAgentTurn, before creating the model client:
const baseInvocation = resolveModelInvocation(sessionRow);
const mergedInvocation = input.modelInvocationOverride
  ? { ...baseInvocation, ...input.modelInvocationOverride }
  : baseInvocation;

// Pass mergedInvocation to createSessionToolLoopModelClient
```
