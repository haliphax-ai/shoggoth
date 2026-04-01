import type { TaskList, TaskState, TaskStatus } from "./types.js";
import type { PollAdapter } from "./orchestrator.js";
import { saveWorkflow } from "./state.js";

// --- Status transition guards ---

/**
 * Ordered status progression. A task can only move forward in this sequence.
 * "paused" is treated as equivalent to "pending" for ordering purposes.
 */
const STATUS_ORDER: Record<TaskStatus, number> = {
  pending: 0,
  paused: 0,
  in_progress: 1,
  done: 2,
  failed: 2,
};

/**
 * Check whether a status transition is valid (forward-only).
 * Terminal states (done, failed) cannot transition to anything.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  // Terminal states cannot transition
  if (from === "done" || from === "failed") return false;
  return STATUS_ORDER[to] >= STATUS_ORDER[from];
}

/**
 * Attempt a guarded status transition. Returns true if the transition was applied.
 */
export function guardedTransition(task: TaskState, newStatus: TaskStatus): boolean {
  if (!isValidTransition(task.status, newStatus)) return false;
  task.status = newStatus;
  return true;
}

// --- Tick lock (prevents overlapping ticks) ---

/**
 * Creates a simple async mutex for protecting tick execution.
 * If a tick is already running, subsequent calls are skipped (not queued).
 */
export function createTickLock(): { acquire(): boolean; release(): void; isLocked(): boolean } {
  let locked = false;
  return {
    acquire(): boolean {
      if (locked) return false;
      locked = true;
      return true;
    },
    release(): void {
      locked = false;
    },
    isLocked(): boolean {
      return locked;
    },
  };
}

// --- Orphan detection ---

export interface OrphanResult {
  orphanedCount: number;
  orphanedTaskIds: number[];
}

/**
 * Detect in_progress tasks whose sessions are no longer alive.
 * Marks orphaned tasks as failed with an appropriate error.
 * Returns a summary of what was found.
 */
export async function detectOrphans(
  wf: TaskList,
  poller: PollAdapter,
): Promise<OrphanResult> {
  const orphanedTaskIds: number[] = [];

  for (const task of wf.tasks) {
    if (task.status !== "in_progress" || !task.sessionKey) continue;

    try {
      const result = await poller.poll(task.sessionKey);
      // If the poll returns a terminal status, the orchestrator's normal tick
      // would handle it. We only care about sessions that are truly gone.
      // A "running" result means the session is alive — skip.
      // A "done" or "failed" result means the session finished — the normal
      // tick will pick it up. We only flag orphans when poll throws (session gone).
      void result;
    } catch {
      // Session is gone — mark as orphaned
      task.status = "failed";
      task.error = "orphaned: subagent session no longer exists";
      task.completedAt = Date.now();
      orphanedTaskIds.push(task.taskDef.id);
    }
  }

  return { orphanedCount: orphanedTaskIds.length, orphanedTaskIds };
}

/**
 * Run orphan detection on a workflow and persist if any were found.
 */
export async function detectAndPersistOrphans(
  wf: TaskList,
  poller: PollAdapter,
  stateDir: string,
): Promise<OrphanResult> {
  const result = await detectOrphans(wf, poller);
  if (result.orphanedCount > 0) {
    saveWorkflow(stateDir, wf);
  }
  return result;
}
