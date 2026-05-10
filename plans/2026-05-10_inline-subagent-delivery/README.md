---
date: 2026-05-10
completed: null
---

# Inline Subagent Result Delivery

## Summary

Deliver background subagent results inline into the parent session's active tool loop (like steering messages) instead of queuing a new turn. Fall back to the current queued-turn behavior when the parent's turn is no longer active.

## Motivation

Background subagent results currently arrive as new messages in the parent's turn queue. This means:

1. The parent's current turn finishes without the result.
2. A new turn starts just to process the subagent's output.
3. Context is fragmented — the model loses continuity between spawning the subagent and receiving its result.

Inline delivery keeps the result in the same conversational turn where the subagent was spawned, giving the model immediate access to the output while it's still working.

## Design

### Delivery Matrix

| Spawn Type                               | Parent Turn Active?    | Behavior                                             |
| ---------------------------------------- | ---------------------- | ---------------------------------------------------- |
| Foreground one-shot (`background=false`) | Yes (blocked on await) | **No change** — already returned as tool call result |
| Background one-shot (`background=true`)  | Yes                    | **Inject via steer channel**                         |
| Background one-shot (`background=true`)  | No (turn finished)     | **No change** — fall back to queued turn             |
| Persistent (non-thread-bound)            | Yes                    | **Inject via steer channel**                         |
| Persistent (non-thread-bound)            | No (turn finished)     | **No change** — fall back to queued turn             |
| Persistent (thread-bound)                | N/A                    | **No change** — communicates via platform thread     |

### Core Mechanism

Both background one-shot and non-thread-bound persistent subagents converge on `deliverSubagentResult()` in `integration-ops.ts`. This single function is the modification point.

The steer channel (`steer-channel.ts`) provides the inline injection path:

- `pushSteer(sessionId, message)` returns `true` if the target session has an active tool loop (a registered steer channel).
- `drainSteers(sessionId)` is called between every model iteration in the tool loop, injecting messages as user-role content via `pushSteerMessage()`.
- If no active loop exists, `pushSteer()` returns `false` — the fallback path fires.

The change: `deliverSubagentResult()` attempts `pushSteer(respondTo, content)` first. On success, the result is injected inline. On failure, the existing `runSessionModelTurn()` path queues a new turn.

### Why This Is Safe

- The steer channel is registered at tool loop start and unregistered in a `finally` block — no window where a message could be pushed but never drained.
- `pushSteer()` is atomic (push to array) — no async race.
- The fallback guarantees delivery even if timing is unlucky.

## Testing Strategy

- **Unit test:** mock `pushSteer` returning `true` → verify `runSessionModelTurn` is NOT called.
- **Unit test:** mock `pushSteer` returning `false` → verify `runSessionModelTurn` IS called (fallback).
- **Integration test:** spawn background one-shot while parent is in tool loop → verify result appears inline in the same turn.
- **Integration test:** spawn background one-shot, parent turn ends before child completes → verify result arrives as new turn.

## Considerations

- Reusing the steer channel means subagent results appear as user-role messages, same as operator steers. If the model confuses the two, a dedicated channel with distinct framing can be added as a follow-up (see Phase 2 in implementation).
- No truncation is applied in the steer path. Consider adding a max-chars cap consistent with the `result` action's default (8000 chars).
- Multiple subagents completing between iterations are drained FIFO. The model sees them in completion order.
- Persistent subagents with multiple turns: only the first turn's result is delivered to the parent (existing behavior unchanged).
- The `wait` and `result` tool actions remain useful for explicit polling patterns but become less necessary for typical background spawns.

## Migration

No migration needed. This is a behavioral change to an internal delivery mechanism. No config, schema, or state changes.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
