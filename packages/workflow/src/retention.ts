import type { TaskList } from "./types.js";
import { listAllWorkflows, deleteWorkflow } from "./state.js";

// --- Constants ---

/** Default: prune completed workflows older than 48 hours. */
export const COMPLETED_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

/** Default: prune paused workflows older than 7 days. */
export const PAUSED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

// --- Types ---

export interface RetentionSummary {
  pruned: number;
  prunedIds: string[];
}

export interface RetentionOptions {
  completedMaxAgeMs?: number;
  pausedMaxAgeMs?: number;
  now?: number;
}

// --- Helpers ---

function isAllTerminal(wf: TaskList): boolean {
  return wf.tasks.every((t) => t.status === "done" || t.status === "failed");
}

function isPaused(wf: TaskList): boolean {
  return (
    wf.tasks.some((t) => t.status === "paused") ||
    // A workflow is effectively paused if it has pending tasks and no in_progress tasks
    // but the real signal is the orchestrator's paused flag. Since we only have disk state,
    // check for the pattern: has non-terminal tasks but nothing in_progress.
    (!isAllTerminal(wf) &&
      !wf.tasks.some((t) => t.status === "in_progress") &&
      wf.tasks.some((t) => t.status === "pending"))
  );
}

/**
 * Determine the "age reference" timestamp for a workflow.
 * For completed workflows: use the latest completedAt among tasks, or createdAt.
 * For paused workflows: use createdAt (they've been sitting idle).
 */
function workflowAgeRef(wf: TaskList): number {
  if (isAllTerminal(wf)) {
    const maxCompleted = Math.max(...wf.tasks.map((t) => t.completedAt ?? 0));
    return maxCompleted > 0 ? maxCompleted : wf.createdAt;
  }
  return wf.createdAt;
}

// --- Public API ---

/**
 * Run retention: prune old completed and paused workflows from disk.
 */
export async function retentionRun(
  baseDir: string,
  opts?: RetentionOptions,
): Promise<RetentionSummary> {
  const completedMaxAge = opts?.completedMaxAgeMs ?? COMPLETED_MAX_AGE_MS;
  const pausedMaxAge = opts?.pausedMaxAgeMs ?? PAUSED_MAX_AGE_MS;
  const now = opts?.now ?? Date.now();

  const workflows = await listAllWorkflows(baseDir);
  const prunedIds: string[] = [];

  for (const wf of workflows) {
    const ageRef = workflowAgeRef(wf);
    const age = now - ageRef;

    if (isAllTerminal(wf) && age > completedMaxAge) {
      await deleteWorkflow(baseDir, wf.id);
      prunedIds.push(wf.id);
    } else if (isPaused(wf) && age > pausedMaxAge) {
      await deleteWorkflow(baseDir, wf.id);
      prunedIds.push(wf.id);
    }
  }

  return { pruned: prunedIds.length, prunedIds };
}

// --- Scheduled retention ---

/**
 * Manages a periodic retention schedule with its own timer instance.
 *
 * Unlike the module-level `startRetentionSchedule` / `stopRetentionSchedule`
 * helpers (which share a single global timer), each `RetentionScheduler`
 * instance holds its own timer handle so multiple schedulers can coexist
 * without interfering with one another.
 */
export class RetentionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Whether a schedule is currently active. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Start a periodic retention schedule.
   * If a schedule is already running, it is replaced.
   */
  start(baseDir: string, intervalMs: number, opts?: RetentionOptions): void {
    this.stop();
    this.timer = setInterval(async () => {
      await retentionRun(baseDir, opts).catch((err) => {
        // Swallow errors from periodic retention runs to prevent timer crash
        console.error("retention run failed:", err);
      });
    }, intervalMs);
  }

  /** Stop the periodic retention schedule, if running. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// --- Module-level convenience (backward compatible) ---

const defaultScheduler = new RetentionScheduler();

export function startRetentionSchedule(
  baseDir: string,
  intervalMs: number,
  opts?: RetentionOptions,
): void {
  defaultScheduler.start(baseDir, intervalMs, opts);
}

export function stopRetentionSchedule(): void {
  defaultScheduler.stop();
}
