# Session Turn Queue — Priority Tiers

**Date:** 2026-04-01
**Status:** Planned

## Summary

Replace the FIFO session turn lock with a tiered priority queue. System-generated events (workflow notifications, steer directives) are processed ahead of normal user messages, with fairness constraints to prevent priority starvation. Tier assignments are configurable, and the design supports future control plane ops for queue skipping.

## Motivation

The current `SessionTurnLock` is a flat FIFO chain. When a workflow completes or a task fails, the notification queues behind any pending user messages. In busy sessions, system events can be delayed significantly. Conversely, a flood of system events (e.g., multiple workflow task completions) can starve user messages indefinitely.

## Design

### Queue Structure

Each session maintains two ordered queues:

```
┌─────────────┐     ┌─────────────┐
│  Priority    │ ──► │   Normal    │
│  (system)    │     │   (user)    │
└─────────────┘     └─────────────┘
```

When the current turn releases, the scheduler picks the next item:

1. Pop from priority queue (if non-empty and fairness budget allows)
2. Otherwise pop from normal queue
3. If both empty, session is idle — clean up

### Fairness: Max Consecutive Priority

To prevent priority starvation, the scheduler tracks consecutive priority pops. After `maxConsecutivePriority` items (default: 3), it forces one normal item through before resuming priority processing. This ensures normal messages make progress even under sustained system event load.

```typescript
interface SchedulerConfig {
  /** Max priority items processed before forcing one normal item. Default: 3. */
  maxConsecutivePriority: number;
}
```

If the normal queue is empty when the fairness check triggers, priority processing continues (no artificial stall).

### Turn Classification

Each `acquire` call includes a `turnKind` string that the scheduler maps to a tier:

```typescript
type TurnTier = "priority" | "normal";

interface TurnQueueEntry {
  turnKind: string;
  resolve: () => void;
}

// acquire now takes a turnKind
acquire(sessionId: string, turnKind?: string): Promise<() => void>;
```

The tier mapping is driven by a configurable set:

```typescript
interface TierConfig {
  /** Turn kinds assigned to the priority tier. Everything else is normal. */
  priorityKinds: Set<string>;
}
```

Default priority kinds:
- `workflow.complete` — workflow completion notification
- `workflow.task_failed` — task failure notification
- `session.steer` — operator steering directive
- `session.send` — inter-session message
- `control` — control plane operations (future)

Default normal kinds:
- `user.message` — inbound user message from messaging surface
- `heartbeat` — periodic heartbeat turn
- Everything not in `priorityKinds`

### Call Site Changes

Each call site that acquires the turn lock passes its `turnKind`:

```typescript
// Inbound user message
const release = await turnLock.acquire(sessionId, "user.message");

// Workflow completion notification
const release = await turnLock.acquire(sessionId, "workflow.complete");

// Workflow task failure
const release = await turnLock.acquire(sessionId, "workflow.task_failed");

// Session steer
const release = await turnLock.acquire(sessionId, "session.steer");
```

### Extensibility: Queue Skip (Future)

The queue supports an `enqueueImmediate` method for future control plane use:

```typescript
/**
 * Insert a turn at the front of the priority queue, ahead of all
 * other queued items. Used by control plane ops to skip the queue.
 * The currently running turn is NOT preempted.
 */
enqueueImmediate(sessionId: string): Promise<() => void>;
```

This is not wired up in this plan — it's a hook for a future control plane op (e.g., `/dequeue`, `/inject`) that lets operators force a turn to the front. The method exists and is tested, but no call sites use it yet.

### Interface

```typescript
export interface SessionTurnQueueOptions {
  /** Turn kinds assigned to the priority tier. */
  priorityKinds?: Set<string>;
  /** Max consecutive priority items before forcing a normal item. Default: 3. */
  maxConsecutivePriority?: number;
}

export class SessionTurnQueue {
  constructor(options?: SessionTurnQueueOptions);

  /** Acquire the turn lock for a session. Queues by tier based on turnKind. */
  acquire(sessionId: string, turnKind?: string): Promise<() => void>;

  /** Insert at the front of the priority queue (for future control plane use). */
  enqueueImmediate(sessionId: string): Promise<() => void>;

  /** Number of queued callers for a session (excluding the active turn). */
  queueLength(sessionId: string): number;

  /** Breakdown of queued callers by tier. */
  queueStats(sessionId: string): { priority: number; normal: number };
}
```

## Implementation Phases

### Phase 1: Refactor SessionTurnLock → SessionTurnQueue

- Replace promise-chaining with explicit per-session queue arrays
- Add `turnKind` parameter to `acquire`
- Implement two-tier scheduling with fairness
- Add `enqueueImmediate` (tested but not wired)
- Add `queueLength` and `queueStats` for observability
- Migrate all existing call sites to pass `turnKind`
- Update existing tests, add new tests for priority ordering and fairness

**Files:**
- `packages/daemon/src/sessions/session-turn-lock.ts` → rename to `session-turn-queue.ts`
- `packages/daemon/src/lib.ts` (update export)
- `packages/platform-discord/src/platform.ts` (update call sites)
- `packages/daemon/src/index.ts` (update call sites for workflow notifications)
- `packages/daemon/test/session-turn-queue.test.ts`

### Phase 2: Configuration

- Add `turnQueue` config section to Shoggoth config schema
- Allow `priorityKinds` and `maxConsecutivePriority` to be set via config
- Wire config into `SessionTurnQueue` construction

**Files:**
- `packages/shared/src/config.ts`
- `packages/daemon/src/index.ts`
- `packages/platform-discord/src/platform.ts`

### Phase 3: Observability

- Add debug logging for queue events (enqueue, dequeue, fairness override)
- Expose queue stats via the control plane status endpoint
- Log warnings when queue depth exceeds a threshold

**Files:**
- `packages/daemon/src/sessions/session-turn-queue.ts`
- `packages/daemon/src/control/integration-ops.ts`

## Testing Strategy

- Priority items are dequeued before normal items
- Fairness: after N consecutive priority items, a normal item is processed
- Fairness skips when normal queue is empty (no artificial stall)
- `enqueueImmediate` jumps ahead of all queued items
- Different sessions remain independent
- `turnKind` defaults to normal when not specified
- `queueStats` returns correct counts
- Config overrides for `priorityKinds` and `maxConsecutivePriority`

## Security Considerations

- `enqueueImmediate` is not exposed to agents or users — only the control plane can use it
- Turn kinds are set by the daemon, not by user input — no injection risk
- Fairness prevents a compromised or misbehaving system component from starving user messages
