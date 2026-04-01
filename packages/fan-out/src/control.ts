import type { TaskDef, TaskList, TaskStatus } from "./types.js";
import type { Orchestrator, KillAdapter } from "./orchestrator.js";
import type { StatusManager } from "./status-manager.js";
import { saveWorkflow, loadWorkflow } from "./state.js";
import { retentionRun, type RetentionSummary, type RetentionOptions } from "./retention.js";
import { getTransitiveDeps } from "./graph.js";
import fs from "node:fs";
import path from "node:path";

// --- Public types ---

export interface WorkflowSummary {
  id: string;
  name: string;
  statusCounts: Record<TaskStatus, number>;
  createdAt: number;
}

export interface ControlPlaneOptions {
  orchestrators: Map<string, Orchestrator>;
  stateDir: string;
  killer: KillAdapter;
  statusManager?: StatusManager | null;
}

// --- Helpers ---

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed";
}

function countStatuses(wf: TaskList): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    failed: 0,
    paused: 0,
  };
  for (const t of wf.tasks) {
    counts[t.status]++;
  }
  return counts;
}

/**
 * Get all downstream task IDs (tasks that transitively depend on the given task).
 * This is the reverse of getTransitiveDeps — we want tasks that have `taskId` as
 * a transitive dependency.
 */
function getDownstreamIds(wf: TaskList, taskId: number): Set<number> {
  const downstream = new Set<number>();
  const stack = [taskId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const [tid, deps] of wf.graph) {
      if (deps.has(current) && !downstream.has(tid)) {
        downstream.add(tid);
        stack.push(tid);
      }
    }
  }

  return downstream;
}

// --- ControlPlane ---

export class ControlPlane {
  private readonly orchestrators: Map<string, Orchestrator>;
  private readonly stateDir: string;
  private readonly killer: KillAdapter;
  private readonly statusManager: StatusManager | null;

  constructor(opts: ControlPlaneOptions) {
    this.orchestrators = opts.orchestrators;
    this.stateDir = opts.stateDir;
    this.killer = opts.killer;
    this.statusManager = opts.statusManager ?? null;
  }

  /** Resolve a workflow — prefer in-memory orchestrator, fall back to disk. */
  private resolveWorkflow(workflowId: string): TaskList {
    const orch = this.orchestrators.get(workflowId);
    if (orch) {
      const wf = orch.getWorkflowStatus();
      if (wf) return wf;
    }

    const wf = loadWorkflow(this.stateDir, workflowId);
    if (wf) return wf;

    throw new Error(`Workflow not found: ${workflowId}`);
  }

  /** Require an active orchestrator for the workflow. */
  private requireOrchestrator(workflowId: string): Orchestrator {
    const orch = this.orchestrators.get(workflowId);
    if (!orch) throw new Error(`Workflow not found: ${workflowId}`);
    return orch;
  }

  /**
   * Kill all active subagents, mark all non-terminal tasks as failed,
   * stop polling, update status, and persist.
   */
  async abort(workflowId: string): Promise<void> {
    const orch = this.requireOrchestrator(workflowId);
    const wf = orch.getWorkflowStatus();
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    // Kill all in-progress sessions
    for (const task of wf.tasks) {
      if (task.status === "in_progress" && task.sessionKey) {
        await this.killer.kill(task.sessionKey);
      }
    }

    // Mark all non-terminal tasks as failed
    const now = Date.now();
    for (const task of wf.tasks) {
      if (!isTerminal(task.status)) {
        task.status = "failed";
        task.error = "aborted: workflow aborted by control plane";
        task.completedAt = now;
      }
    }

    // Stop polling and mark complete
    orch.stopPolling();
    orch.setCompleted(true);

    // Update status message
    if (this.statusManager) {
      await this.statusManager.updateStatus(wf);
    }

    // Persist
    saveWorkflow(this.stateDir, wf);
  }

  /**
   * Pause the orchestrator — in-flight tasks continue, no new spawns.
   */
  async pause(workflowId: string): Promise<void> {
    const orch = this.requireOrchestrator(workflowId);
    const wf = orch.getWorkflowStatus();
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    orch.setPaused(true);

    // Update status message
    if (this.statusManager) {
      await this.statusManager.updateStatus(wf);
    }

    // Persist
    saveWorkflow(this.stateDir, wf);
  }

  /**
   * Resume from paused state — spawn ready tasks on next tick.
   */
  async resume(workflowId: string): Promise<void> {
    const orch = this.requireOrchestrator(workflowId);
    const wf = orch.getWorkflowStatus();
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    orch.setPaused(false);

    // Update status message
    if (this.statusManager) {
      await this.statusManager.updateStatus(wf);
    }

    // Persist
    saveWorkflow(this.stateDir, wf);
  }

  /**
   * Return the current workflow state as a structured object.
   */
  async status(workflowId: string): Promise<TaskList> {
    return this.resolveWorkflow(workflowId);
  }

  /**
   * List all workflows from disk with summary info.
   */
  async list(agentChainId?: string): Promise<WorkflowSummary[]> {
    if (!fs.existsSync(this.stateDir)) return [];

    const files = fs.readdirSync(this.stateDir).filter((f) => f.endsWith(".json"));
    const summaries: WorkflowSummary[] = [];

    for (const file of files) {
      try {
        const wfId = path.basename(file, ".json");
        const wf = loadWorkflow(this.stateDir, wfId);
        if (!wf) continue;

        summaries.push({
          id: wf.id,
          name: wf.name,
          statusCounts: countStatuses(wf),
          createdAt: wf.createdAt,
        });
      } catch {
        // skip corrupt files
      }
    }

    return summaries;
  }

  /**
   * Repost the current status message for the workflow.
   */
  async post(workflowId: string): Promise<void> {
    const wf = this.resolveWorkflow(workflowId);

    if (!this.statusManager) {
      throw new Error("No status manager configured");
    }

    await this.statusManager.postInitialStatus(wf);
  }

  /**
   * Edit a task definition. Rejects edits to in_progress tasks.
   */
  async edit(
    workflowId: string,
    taskId: number,
    updates: Partial<Pick<TaskDef, "prompt" | "failureBehavior" | "failureNotification" | "runtimeLimitMs">>,
  ): Promise<void> {
    const orch = this.orchestrators.get(workflowId);
    let wf: TaskList;

    if (orch) {
      wf = orch.getWorkflowStatus()!;
      if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
    } else {
      const loaded = loadWorkflow(this.stateDir, workflowId);
      if (!loaded) throw new Error(`Workflow not found: ${workflowId}`);
      wf = loaded;
    }

    const task = wf.tasks.find((t) => t.taskDef.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in workflow ${workflowId}`);

    if (task.status === "in_progress") {
      throw new Error(
        `Cannot edit task ${taskId}: task is in_progress. Pause or wait for completion first.`,
      );
    }

    // Apply allowed updates
    if (updates.prompt !== undefined) task.taskDef.prompt = updates.prompt;
    if (updates.failureBehavior !== undefined) task.taskDef.failureBehavior = updates.failureBehavior;
    if (updates.failureNotification !== undefined) task.taskDef.failureNotification = updates.failureNotification;
    if (updates.runtimeLimitMs !== undefined) task.taskDef.runtimeLimitMs = updates.runtimeLimitMs;

    // Persist immediately
    saveWorkflow(this.stateDir, wf);
  }

  /**
   * Retry a failed task: reset to pending, clear error/output/timestamps,
   * reset downstream blocked tasks, resume if paused.
   * If cascade=true, also reset completed downstream tasks.
   */
  async retry(workflowId: string, taskId: number, cascade?: boolean): Promise<void> {
    const orch = this.requireOrchestrator(workflowId);
    const wf = orch.getWorkflowStatus();
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    const task = wf.tasks.find((t) => t.taskDef.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in workflow ${workflowId}`);

    if (task.status !== "failed") {
      throw new Error(`Cannot retry task ${taskId}: task is not failed (status: ${task.status})`);
    }

    // Reset the target task
    this.resetTask(task);

    // Get all downstream task IDs
    const downstreamIds = getDownstreamIds(wf, taskId);

    for (const t of wf.tasks) {
      if (!downstreamIds.has(t.taskDef.id)) continue;

      if (t.status === "failed") {
        // Always reset failed downstream tasks (they were likely blocked)
        this.resetTask(t);
      } else if (cascade && t.status === "done") {
        // Cascade: also reset completed downstream tasks
        this.resetTask(t);
      }
    }

    // Resume if paused
    if (orch.isPaused()) {
      orch.setPaused(false);
    }

    // Reset completed state so the orchestrator can continue processing
    orch.setCompleted(false);

    // Update status message
    if (this.statusManager) {
      await this.statusManager.updateStatus(wf);
    }

    // Persist
    saveWorkflow(this.stateDir, wf);
  }

  /**
   * Wait for a workflow to complete (all tasks terminal). Polls at the
   * workflow's configured interval until done or timeout.
   */
  async wait(workflowId: string, timeoutMs?: number): Promise<TaskList> {
    const timeout = timeoutMs ?? 600_000; // default 10 minutes
    const start = Date.now();

    while (true) {
      const wf = this.resolveWorkflow(workflowId);
      const allTerminal = wf.tasks.every((t) => isTerminal(t.status));
      if (allTerminal) return wf;

      if (Date.now() - start >= timeout) {
        throw new Error(`wait timed out after ${timeout}ms for workflow ${workflowId}`);
      }

      const pollMs = Math.min(wf.pollingIntervalMs, timeout - (Date.now() - start));
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Run retention: prune old completed and paused workflows from disk.
   */
  async retention(opts?: RetentionOptions): Promise<RetentionSummary> {
    const summary = retentionRun(this.stateDir, opts);

    // Remove pruned workflows from in-memory orchestrator map
    for (const id of summary.prunedIds) {
      const orch = this.orchestrators.get(id);
      if (orch) {
        orch.stopPolling();
        this.orchestrators.delete(id);
      }
    }

    return summary;
  }

  private resetTask(task: { status: TaskStatus; error?: string; output?: string; startedAt?: number; completedAt?: number; sessionKey?: string }): void {
    task.status = "pending";
    task.error = undefined;
    task.output = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.sessionKey = undefined;
  }
}
