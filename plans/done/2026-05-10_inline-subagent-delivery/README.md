---
date: 2026-05-10
completed: null
---

# Inline Subagent Result Delivery

## Summary

Add a `delivery_mode` parameter to subagent spawns that controls how completed turn results are delivered back to the parent session: inline into the active tool loop (`inline`), queued as a new turn (`queue`), or not delivered at all (`drop`). Default is `inline`. Applies to all spawn types except thread-bound persistent subagents. Also deliver all persistent subagent turn responses (not just the first).

## Motivation

Background subagent results currently arrive as new messages in the parent's turn queue. This means:

1. The parent's current turn finishes without the result.
2. A new turn starts just to process the subagent's output.
3. Context is fragmented — the model loses continuity between spawning the subagent and receiving its result.

Additionally, persistent (non-thread-bound) subagents only deliver their first turn's result to the parent. Subsequent turns are silently dropped, leaving the parent unaware of ongoing work.

Inline delivery keeps results in the same conversational turn where the subagent was spawned, giving the model immediate access. The `delivery_mode` parameter gives agents explicit control over this behavior for all spawn types.

## Design

### Delivery Mode Parameter

A new `delivery_mode` field on spawn actions (`spawn_one_shot`, `spawn_persistent`):

| Value              | Behavior                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `inline` (default) | Inject result into parent's active tool loop via steer channel. Falls back to `queue` if no active loop. |
| `queue`            | Always deliver as a new turn in the parent's turn queue.                                                 |
| `drop`             | Don't deliver. Parent must use `wait` or `result` actions to retrieve output.                            |

Applies to **all** subagent spawns except thread-bound persistent subagents (which communicate via their platform thread).

### Interaction with `background` Flag (one-shot)

The `background` flag and `delivery_mode` are orthogonal:

- `background=false` + `delivery_mode=inline`: Block and return result as tool call response (current foreground behavior).
- `background=false` + `delivery_mode=queue`: Block until complete, then deliver as queued turn. Tool call returns session metadata only.
- `background=false` + `delivery_mode=drop`: Block until complete, discard result. Tool call returns session metadata only.
- `background=true` + `delivery_mode=inline`: Return immediately, inject result into active loop when subagent completes.
- `background=true` + `delivery_mode=queue`: Return immediately, queue new turn when subagent completes.
- `background=true` + `delivery_mode=drop`: Fire-and-forget. Return immediately, no delivery.

### Delivery Matrix

| Spawn Type                | `delivery_mode` | Parent Turn Active? | Behavior                                                  |
| ------------------------- | --------------- | ------------------- | --------------------------------------------------------- |
| One-shot (fg)             | `inline`        | Yes (blocked)       | Tool call result returned inline (current behavior)       |
| One-shot (fg)             | `queue`         | Yes (blocked)       | Block, then deliver as queued turn; tool returns metadata |
| One-shot (fg)             | `drop`          | Yes (blocked)       | Block, then discard; tool returns metadata                |
| One-shot (bg)             | `inline`        | Yes                 | Inject via steer channel                                  |
| One-shot (bg)             | `inline`        | No                  | Fall back to `queue`                                      |
| One-shot (bg)             | `queue`         | any                 | New turn in parent queue                                  |
| One-shot (bg)             | `drop`          | any                 | No delivery                                               |
| Persistent (non-thread)   | `inline`        | Yes                 | Inject via steer channel (all turns)                      |
| Persistent (non-thread)   | `inline`        | No                  | Fall back to `queue`                                      |
| Persistent (non-thread)   | `queue`         | any                 | New turn in parent queue (all turns)                      |
| Persistent (non-thread)   | `drop`          | any                 | No delivery                                               |
| Persistent (thread-bound) | any             | N/A                 | Communicates via platform thread (unchanged)              |

### All-Turn Delivery for Persistent Subagents

Currently only the first turn result is delivered to the parent. This changes: every turn completion for a non-thread-bound persistent subagent delivers its result according to `delivery_mode`. This requires hooking into the turn completion path for persistent subagent sessions beyond just the initial spawn.

### System Context Framing

Results delivered to the parent (both inline and queued) are wrapped in the trusted system context envelope, consistent with timer messages and other system-injected content:

```
--- BEGIN TRUSTED SYSTEM CONTEXT [token:<session_token>] ---
[subagent.result]
Result delivered from subagent <childSessionId>.

{
  "child_session_id": "<childSessionId>",
  "mode": "one_shot" | "persistent"
}
--- END TRUSTED SYSTEM CONTEXT [token:<session_token>] ---

[Subagent completed] session_id: <childSessionId>

<assistantText (truncated to max_chars)>
```

### Max-Char Cap

Results delivered via inline or queue paths are truncated to 8000 characters (matching the `result` action's default). This prevents large subagent outputs from overwhelming the parent's context.

### Inline Injection Mechanism

The steer channel (`steer-channel.ts`) provides the inline injection path:

- `pushSteer(sessionId, message)` returns `true` if the target session has an active tool loop.
- `drainSteers(sessionId)` is called between every model iteration in the tool loop.
- If no active loop exists, `pushSteer()` returns `false` — falls back to `queue` behavior.

### Surfaces

The `delivery_mode` parameter must be exposed in:

1. **Tool descriptor** (`packages/mcp-integration/src/builtin-shoggoth-tools.ts`) — add to `subagentToolArgs.properties`
2. **CLI** (`packages/cli/src/run-subagent.ts`) — add `--delivery-mode` flag
3. **Control plane op** (`packages/daemon/src/control/integration-ops.ts`) — read from payload, store on session, pass to delivery function

## Testing Strategy

- **Unit test:** `delivery_mode=inline` + active parent loop → result injected via steer, `runSessionModelTurn` NOT called.
- **Unit test:** `delivery_mode=inline` + no active parent loop → falls back to `runSessionModelTurn`.
- **Unit test:** `delivery_mode=queue` → always calls `runSessionModelTurn` regardless of loop state.
- **Unit test:** `delivery_mode=drop` → neither steer nor `runSessionModelTurn` called.
- **Unit test:** result text exceeding 8000 chars is truncated.
- **Unit test:** foreground one-shot with `delivery_mode=queue` → blocks but returns metadata, delivers as queued turn.
- **Unit test:** foreground one-shot with `delivery_mode=drop` → blocks but returns metadata, no delivery.
- **Integration test:** persistent subagent multiple turns → all results delivered to parent.
- **Integration test:** background one-shot with `delivery_mode=drop` → fire-and-forget, parent verifies via filesystem.

## Considerations

- Reusing the steer channel means subagent results appear as user-role messages, same as operator steers. The system context framing differentiates them for the model.
- Multiple subagents completing between iterations are drained FIFO in completion order.
- For persistent subagents, delivering all turns means the parent could receive many messages. The `drop` mode gives agents an escape hatch.
- The `wait` and `result` tool actions remain useful for `drop` mode and for retrieving results after the fact.
- Foreground one-shot with `delivery_mode=drop` still blocks — useful when the parent wants to ensure the work is done but doesn't need the text output (e.g., the subagent wrote files the parent can check).
- Thread-bound persistent subagents ignore `delivery_mode` entirely — they communicate via their platform thread.

## Migration

No migration needed. The new parameter defaults to `inline`, which is a behavioral change from the current `queue` behavior. Agents that rely on the current queued-turn behavior can explicitly set `delivery_mode: "queue"`.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
