# Inline Subagent Result Delivery

## Summary

When a background one-shot or non-thread-bound persistent subagent completes, deliver its result inline into the parent session's active tool loop (like steering messages) instead of queuing a new turn. Fall back to the current queued-turn behavior when the parent's turn is no longer active.

## Motivation

Currently, background subagent results arrive as new messages in the parent's turn queue. This means:

1. The parent's current turn finishes without the result.
2. A new turn starts just to process the subagent's output.
3. Context is fragmented — the model loses continuity between spawning the subagent and receiving its result.

Inline delivery keeps the result in the same conversational turn where the subagent was spawned, giving the model immediate access to the output while it's still working.

## Delivery Matrix

| Spawn Type                               | Parent Turn Active?    | Behavior                                             |
| ---------------------------------------- | ---------------------- | ---------------------------------------------------- |
| Foreground one-shot (`background=false`) | Yes (blocked on await) | **No change** — already returned as tool call result |
| Background one-shot (`background=true`)  | Yes                    | **NEW: inject via steer channel**                    |
| Background one-shot (`background=true`)  | No (turn finished)     | **No change** — fall back to queued turn             |
| Persistent (non-thread-bound)            | Yes                    | **NEW: inject via steer channel**                    |
| Persistent (non-thread-bound)            | No (turn finished)     | **No change** — fall back to queued turn             |
| Persistent (thread-bound)                | N/A                    | **No change** — communicates via platform thread     |

## Design

### Core Change

Both background one-shot and non-thread-bound persistent subagents already converge on `deliverSubagentResult()` in `packages/daemon/src/control/integration-ops.ts`. The change is to attempt inline injection first:

```typescript
async function deliverSubagentResult(ext, opts): Promise<void> {
  const { childSessionId, respondTo, internalDelivery, mode, assistantText, subLog } = opts;
  const content = `[Subagent completed] session_id: ${childSessionId}\n\n${assistantText}`;

  // Try inline injection (parent has active tool loop)
  if (pushSteer(respondTo, content)) {
    subLog.info("subagent result injected inline via steer channel", {
      childSessionId,
      respondTo,
      mode,
    });
    return;
  }

  // Fallback: parent turn is finished, queue a new turn
  await ext.runSessionModelTurn({
    sessionId: respondTo,
    userContent: content,
    userMetadata: { subagent_result: true, child_session_id: childSessionId, mode },
    systemContext: {
      kind: "subagent.result",
      summary: `Result delivered from subagent ${childSessionId}.`,
      data: { child_session_id: childSessionId, mode },
    },
    delivery: { kind: "internal" },
  });
}
```

### Why This Works

- `pushSteer()` returns `true` only if the target session has a registered steer channel (i.e., an active tool loop).
- The steer channel is registered at tool loop start and unregistered in a `finally` block — no race condition gap.
- `drainSteers()` is called between every model iteration in the tool loop, so the result is picked up on the next iteration.
- If the parent's turn has ended, `pushSteer()` returns `false` and we fall back to the existing `runSessionModelTurn` path.

### Files to Modify

| File                                             | Change                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/daemon/src/control/integration-ops.ts` | Add `pushSteer` import; modify `deliverSubagentResult()` to try inline first |

That's it for the minimal version — one file, ~5 lines of new logic.

## Optional Enhancement: Dedicated Channel

The minimal approach reuses the steer channel, which means subagent results appear as user-role messages indistinguishable from operator steers. A cleaner alternative:

### Additional Files (if pursued)

| File                                                             | Change                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/daemon/src/sessions/steer-channel.ts`                  | Add parallel `pushSubagentResult()` / `drainSubagentResults()` functions |
| `packages/daemon/src/sessions/tool-loop.ts`                      | Drain subagent results alongside steers, with distinct framing           |
| `packages/daemon/src/sessions/session-tool-loop-model-client.ts` | Add `pushSubagentResultMessage(content)` method with appropriate framing |

This would let the model distinguish between operator guidance and subagent output. The framing could use a system-context-like prefix or structured markers.

**Recommendation:** Start with the minimal approach (reuse steer channel). If testing reveals the model confuses steers with subagent results, add the dedicated channel as a follow-up.

## Edge Cases

1. **Multiple subagents complete between iterations.** All results are drained FIFO. The model sees them in completion order. This is acceptable.

2. **Large result text.** No truncation is applied in the steer path. Consider adding a max-chars cap consistent with the `result` action's default (8000 chars).

3. **The `wait` and `result` actions.** These remain useful for explicit polling patterns (e.g., workflow orchestration) but become less necessary for typical background spawns.

4. **Persistent subagent with multiple turns.** Only the first turn's result is delivered to the parent (existing behavior). Subsequent turns in a non-thread-bound persistent subagent don't auto-deliver. This plan doesn't change that.

## Testing

- Unit test: mock `pushSteer` returning `true` → verify `runSessionModelTurn` is NOT called.
- Unit test: mock `pushSteer` returning `false` → verify `runSessionModelTurn` IS called (fallback).
- Integration test: spawn background one-shot while parent is in tool loop → verify result appears inline.
- Integration test: spawn background one-shot, parent turn ends before child completes → verify result arrives as new turn.

## Rollout

1. Implement minimal change (steer channel reuse).
2. Add unit tests for `deliverSubagentResult`.
3. Manual testing with real subagent spawns.
4. If framing issues arise, implement dedicated channel enhancement.
