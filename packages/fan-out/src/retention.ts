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

function isAllDone(wf: TaskList): boolean {
  return wf.tasks.every((t) => t.status === "done");
}

function isPaused(wf: TaskList): boolean {
  return wf.tasks.some((t) => t.status === "paused") ||
    // A workflow is effectively paused if it has pending tasks and no in_progress tasks
    // but the real signal is the orchestrator's paused flag. Since we only have disk state,
    // check for the pattern: has non-terminal tasks but nothing in_progress.
    (!isAllTerminal(wf) && !wf.tasks.some((t) => t.status === "in_progress") && wf.tasks.some((t) => t.status === "pending"));
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
export function retentionRun(baseDir: string, opts?: RetentionOptions): RetentionSummary {
  const completedMaxAge = opts?.completedMaxAgeMs ?? COMPLETED_MAX_AGE_MS;
  const pausedMaxAge = opts?.pausedMaxAgeMs ?? PAUSED_MAX_AGE_MS;
  const now = opts?.now ?? Date.now();

  const workflows = listAllWorkflows(baseDir);
  const prunedIds: string[] = [];

  for (const wf of workflows) {
    const ageRef = workflowAgeRef(wf);
    const age = now - ageRef;

    if (isAllTerminal(wf) && age > completedMaxAge) {
      deleteWorkflow(baseDir, wf.id);
      prunedIds.push(wf.id);
    } else if (isPaused(wf) && age > pausedMaxAge) {
      deleteWorkflow(baseDir, wf.id);
      prunedIds.push(wf.id);
    }
  }

  return { pruned: prunedIds.length, prunedIds };
}

// --- Scheduled retention ---

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export function startRetentionSchedule(baseDir: string, intervalMs: number, opts?: RetentionOptions): void {
  stopRetentionSchedule();
  retentionTimer = setInterval(() => retentionRun(baseDir, opts), intervalMs);
}

export function stopRetentionSchedule(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
