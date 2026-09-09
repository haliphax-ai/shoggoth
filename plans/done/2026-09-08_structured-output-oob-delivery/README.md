---
date: 2026-09-08
completed: never
---

# Structured Output for Out-of-Band Delivery

## Summary

Replace the "call `builtin-message action=post`" context hint pattern with structured output (`responseSchema`) for all out-of-band model turns — subagent results and timer fires. Agents fill in `to_operator` and `to_sender` fields; the system handles routing. This eliminates the class of bugs where agents fail to surface results to the operator.

## Motivation

When a subagent completes out-of-band (no active tool loop in the parent session), the system injects a context hint telling the agent to call `builtin-message action=post` to surface results to the operator. Agents repeatedly fail to follow this instruction, so results silently vanish.

The same problem affects timer fires: agents are told "replies will be dropped, respond with `NO_REPLY`" and must use `builtin-message` to reach the operator — which they also fail to do.

The structured output approach makes the agent's response itself the delivery mechanism. The agent fills in structured fields (`to_operator`, `to_sender`), and the system routes them. No tool calls required, no sentinels to remember, no compliance gap.

## Design

### Core Idea

Inject a `responseSchema` on the `ModelInvocationParams` for out-of-band model turns. The existing structured output infrastructure (OpenAI, Gemini, Anthropic adapters — all support `responseSchema` with validation and retry) handles the rest. After the turn completes, the system parses the structured response and delivers each field to its destination.

### Schema Variants

Two schema variants, selected by context:

**With sender** (subagent results — the parent session needs to reply to both the operator and the originating subagent):

```json
{
  "to_operator": "string | null",
  "to_sender": "string | null"
}
```

**Without sender** (timer fires — no originating session to reply to):

```json
{
  "to_operator": "string | null"
}
```

`null` values are the suppression mechanism — no `NO_REPLY` sentinel needed. If the agent has nothing to report, it sets the field to `null`.

### Delivery Logic

After the model turn completes with a validated structured response:

1. Parse the JSON response → extract `to_operator` and `to_sender`
2. If `to_operator` is non-null → post via `PlatformDeliveryRegistry.resolveOperatorDelivery()` to the messaging surface
3. If `to_sender` is non-null (subagent results only) → deliver via `pushSteer()` (inline) or `runSessionModelTurn()` (queue)
4. If both are null → nothing delivered (valid choice by the agent)

### Schema Injection Point

The schema is injected via a new `modelInvocationOverride` parameter on `runSessionModelTurn`. This threads through to `executeSessionAgentTurn` → `createSessionToolLoopModelClient` → `completeWithTools()`, where the provider adapter applies the schema. The override merges into the session's existing model invocation params.

This is cleaner than persisting the schema on the session row (no stale state, no cleanup).

### Context Hint Changes

**Current (subagent result, queue path):**

```
[Subagent completed] session_id: <id>

<result text>

— Your reply text is delivered to the subagent, not to the operator.
— This delivery was out of band (no active tool loop). To surface anything to the operator, call `builtin-message action=post`.
```

**Proposed (subagent result, queue path):**

```
[Subagent completed] session_id: <id>

<result text>
```

With system context guidance:

```
This is an out-of-band message. Respond with structured output.
- to_operator: Message to surface to the operator (null = nothing to show)
- to_sender: Message to reply to the originating session (null = nothing to send back)
Either field may be null. The system handles delivery.
```

**Current (timer fire):**

```
Replies to this turn will be dropped. Respond with NO_REPLY. If you need to surface information to the user, use alternate means such as the builtin-message tool.
```

**Proposed (timer fire):**

```
This is an out-of-band message. Respond with structured output.
- to_operator: Message to surface to the operator (null = nothing to show)
The system handles delivery.
```

### Inline Steer Path (Unchanged)

When the parent has an active tool loop and `pushSteer()` succeeds, the subagent result is injected directly into the ongoing conversation. The parent's next model iteration processes it as a user message and produces a normal reply. This path does not use structured output — the agent's reply goes through the normal tool loop response flow. The structured output approach only applies to the queue/fallback path where a new model turn is spawned.

## Testing Strategy

- **Unit tests for schema definitions**: Verify both schema variants are valid JSON Schema, have correct required fields, and match expected structure.
- **Unit tests for `deliverOobStructuredResponse()`**: Test parsing, null handling, routing to operator/sender, truncation, error cases.
- **Unit tests for `modelInvocationOverride` threading**: Verify the override merges correctly into session model invocation params.
- **Integration tests for subagent result delivery**: Spawn a subagent with queue delivery, verify structured output is used, verify `to_operator` is posted to the messaging surface, verify `to_sender` is delivered back to the subagent.
- **Integration tests for timer fire delivery**: Fire a timer, verify structured output is used, verify `to_operator` is posted.
- **Integration tests for suppression**: Verify `null` values result in no delivery.
- **Integration tests for validation failure**: Verify the tool loop retries (up to 2 times) on validation failure, and that a final failure results in no delivery.
- **Regression tests**: Existing `deliverSubagentResult` tests should continue to pass (inline path unchanged). Existing timer tests should pass with updated expectations.

## Considerations

- **Validation failure after retries**: If the model fails to produce conforming output after 3 attempts (initial + 2 retries), the turn fails and nothing is delivered. This is acceptable — it's strictly better than the current state where agents silently fail to call `builtin-message`.
- **Truncation**: `deliverSubagentResult` already truncates to `maxChars` (default 8000). The delivery function should also truncate `to_operator` to platform limits (e.g., Discord 2000 chars).
- **Channel unavailable**: If `PlatformDeliveryRegistry.resolveOperatorDelivery()` returns undefined (no delivery configured), `to_operator` is silently dropped. Same as today.
- **Persistent subagents with thread bindings**: Thread-bound subagents communicate via their platform thread, not `deliverSubagentResult()`. Unaffected.
- **Mixed model capabilities**: `structuredOutputMode: "none"` means no schema is sent to the provider. The schema instructions are still in the prompt; validation happens after the fact. Best-effort mode is the default.
- **Backward compatibility**: This is an additive change. Existing delivery paths (inline steer, workflow notifications) are unaffected. The only behavioral change is on the queue/fallback path and timer fires.
- **No new provider adapter support needed**: All three adapters (OpenAI, Gemini, Anthropic) already support `responseSchema`. The `OutOfBandResponse` is a simple JSON Schema — no exotic types.
- **Workflow notifications**: Already use `messaging_surface` delivery and don't go through `deliverSubagentResult()`. Unaffected.

## Migration

No migration needed. This is an additive change to existing delivery paths. No database schema changes, no config changes, no breaking changes to existing behavior.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- Structured output research: `projects/shoggoth/tmp/structured-output-oob-research.md`
- Auto-deliver research: `var/lib/shoggoth/workspaces/developer/tmp/research-auto-deliver-subagent-result.md`
