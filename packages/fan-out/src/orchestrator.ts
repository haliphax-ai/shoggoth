import { randomUUID } from "node:crypto";
import type { TaskDef, TaskState, TaskList, DependencyGraph } from "./types.js";
import { parseGraph, validateGraph } from "./graph.js";
import { parseTemplateRefs, validateTemplateRefs, resolveTemplates } from "./templates.js";
import { canSpawn } from "./depth.js";
import { saveWorkflow, loadWorkflow } from "./state.js";
import type { StatusManager } from "./status-manager.js";

// --- Adapter interfaces (dependency injection for testability) ---

export interface SpawnRequest {
  taskId: number;
  prompt: string;
  replyTo: string;
  timeoutMs: number;
  workflowId?: string;
}

export interface PollResult {
  status: "running" | "done" | "failed";
  output?: string;
  error?: string;
}

export interface SpawnAdapter {
  spawn(req: SpawnRequest): Promise<string>;
}

export interface PollAdapter {
  poll(sessionKey: string): Promise<PollResult>;
}

export interface NotifyAdapter {
  notify(workflowId: string, success: boolean, context?: { replyTo: string }): Promise<void>;
}

export interface NotificationAdapter {
  sendNotification(target: string, message: string): Promise<void>;
}

export interface KillAdapter {
  kill(sessionKey: string): Promise<void>;
}

export interface OrchestratorOptions {
  stateDir: string;
  currentDepth: number;
  maxDepth: number;
  replyTo: string;
  pollingIntervalMs: number;
  runtimeLimitMs: number;
  name?: string;
}

// --- Helpers ---

function isTerminal(status: TaskState["status"]): boolean {
  return status === "done" || status === "failed";
}

function taskMap(tasks: TaskState[]): Map<number, TaskState> {
  const m = new Map<number, TaskState>();
  for (const t of tasks) m.set(t.taskDef.id, t);
  return m;
}

/**
 * Check if a task has any dependency that failed (directly or transitively
 * blocking it). A task is blocked if any of its direct deps are failed,
 * or if any direct dep is pending and itself blocked.
 */
function isBlocked(taskId: number, graph: DependencyGraph, tasks: Map<number, TaskState>): boolean {
  const deps = graph.get(taskId);
  if (!deps || deps.size === 0) return false;

  for (const depId of deps) {
    const dep = tasks.get(depId);
    if (!dep) return true; // missing dep = blocked
    if (dep.status === "failed") return true;
    if (dep.status === "pending" && isBlocked(depId, graph, tasks)) return true;
  }
  return false;
}

function formatFailureMessage(task: TaskState): string {
  const desc = task.taskDef.prompt.slice(0, 100);
  return `Task ${task.taskDef.id} failed: "${desc}" — ${task.error ?? "unknown error"}`;
}

// --- Orchestrator ---

export class Orchestrator {
  private readonly spawner: SpawnAdapter;
  private readonly poller: PollAdapter;
  private readonly notifier: NotifyAdapter;
  private readonly statusManager: StatusManager | null;
  private readonly notifications: NotificationAdapter | null;
  private readonly killer: KillAdapter | null;

  private workflow: TaskList | null = null;
  private opts: OrchestratorOptions | null = null;
  private completed = false;
  private paused = false;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    spawner: SpawnAdapter,
    poller: PollAdapter,
    notifier: NotifyAdapter,
    statusManager?: StatusManager,
    notifications?: NotificationAdapter,
    killer?: KillAdapter,
  ) {
    this.spawner = spawner;
    this.poller = poller;
    this.notifier = notifier;
    this.statusManager = statusManager ?? null;
    this.notifications = notifications ?? null;
    this.killer = killer ?? null;
  }

  /** Start a new workflow. Returns the workflow ID. */
  async start(tasks: TaskDef[], graphDsl: string, opts: OrchestratorOptions): Promise<string> {
    // Depth check
    if (!canSpawn(opts.currentDepth, opts.maxDepth)) {
      throw new Error("Cannot start workflow: spawn depth limit reached");
    }

    // Parse and validate graph
    const graph = parseGraph(graphDsl);
    const taskIds = new Set(tasks.map((t) => t.id));
    validateGraph(graph, taskIds);

    // Validate template refs for each task
    for (const task of tasks) {
      const refs = parseTemplateRefs(task.prompt);
      if (refs.length > 0) {
        validateTemplateRefs(task.id, refs, graph);
      }
    }

    // Build workflow
    const taskStates: TaskState[] = tasks.map((td) => ({
      taskDef: td,
      status: "pending" as const,
    }));

    const workflow: TaskList = {
      id: randomUUID(),
      name: opts.name ?? `workflow-${Date.now()}`,
      tasks: taskStates,
      graph,
      pollingIntervalMs: opts.pollingIntervalMs,
      createdAt: Date.now(),
    };

    this.workflow = workflow;
    this.opts = opts;
    this.completed = false;
    this.paused = false;

    // Persist initial state
    saveWorkflow(opts.stateDir, workflow);

    // Spawn ready tasks (roots with no dependencies)
    await this.spawnReadyTasks();

    // Persist after initial spawn wave
    saveWorkflow(opts.stateDir, workflow);

    // Post initial status message
    if (this.statusManager) {
      await this.statusManager.postInitialStatus(workflow);
    }

    return workflow.id;
  }

  /** Run a single poll/orchestration cycle. Used directly in tests. */
  async tick(): Promise<void> {
    if (!this.workflow || !this.opts || this.completed) return;

    // Poll in-progress tasks (always, even when paused)
    await this.pollInProgress();

    // Check runtime limits
    await this.enforceRuntimeLimits();

    // Handle failures from this tick
    await this.handleFailures();

    // Only spawn new tasks and mark blocked if not paused
    if (!this.paused) {
      // Mark blocked pending tasks as failed
      this.markBlockedTasks();

      // Spawn newly ready tasks
      await this.spawnReadyTasks();
    }

    // Persist state
    saveWorkflow(this.opts.stateDir, this.workflow);

    // Update status message
    if (this.statusManager) {
      await this.statusManager.updateStatus(this.workflow);
    }

    // Check for completion
    await this.checkCompletion();
  }

  /** Start the automatic polling loop. */
  startPolling(): void {
    if (!this.workflow || !this.opts) return;
    this.pollingTimer = setInterval(() => this.tick(), this.opts.pollingIntervalMs);
  }

  /** Stop the automatic polling loop. */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /** Whether the workflow has reached a terminal state. */
  isComplete(): boolean {
    return this.completed;
  }

  /** Whether the orchestrator is paused. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Set the paused state externally (used by control plane). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Set the completed state externally (used by control plane abort/retry). */
  setCompleted(value: boolean): void {
    this.completed = value;
  }

  /** Get current workflow status snapshot. */
  getWorkflowStatus(): TaskList | null {
    return this.workflow;
  }

  /** Restore a workflow from persisted state (used for resume on startup). */
  restore(wf: TaskList, opts: OrchestratorOptions): void {
    this.workflow = wf;
    this.opts = opts;
    this.completed = false;
  }

  // --- Internal ---

  private async pollInProgress(): Promise<void> {
    const wf = this.workflow!;

    for (const task of wf.tasks) {
      if (task.status !== "in_progress" || !task.sessionKey) continue;

      const result = await this.poller.poll(task.sessionKey);

      if (result.status === "done") {
        task.status = "done";
        task.output = result.output;
        task.completedAt = Date.now();
      } else if (result.status === "failed") {
        task.status = "failed";
        task.error = result.error;
        task.completedAt = Date.now();
      }
      // "running" → no change
    }
  }

  private async enforceRuntimeLimits(): Promise<void> {
    const wf = this.workflow!;
    const opts = this.opts!;
    const now = Date.now();

    for (const task of wf.tasks) {
      if (task.status !== "in_progress" || !task.sessionKey || !task.startedAt) continue;

      const limit = task.taskDef.runtimeLimitMs ?? opts.runtimeLimitMs;
      const elapsed = now - task.startedAt;

      if (elapsed > limit) {
        // Kill the session
        if (this.killer) {
          await this.killer.kill(task.sessionKey);
        }

        task.status = "failed";
        task.error = `timeout: task exceeded runtime limit of ${limit}ms`;
        task.completedAt = now;
      }
    }
  }

  /** Process failure behaviors and notifications for any newly failed tasks. */
  private async handleFailures(): Promise<void> {
    const wf = this.workflow!;
    const opts = this.opts!;

    // Collect tasks that just failed this tick (have completedAt set recently and are failed)
    // We process all failed tasks that haven't been handled yet.
    // To avoid re-processing, we check for tasks that are failed and have no special marker.
    // Simple approach: iterate and handle based on behavior. The abort/pause actions are idempotent.
    const newlyFailed = wf.tasks.filter(
      (t) => t.status === "failed" && t.completedAt !== undefined && !t.error?.startsWith("blocked:") && !t.error?.startsWith("aborted:")
    );

    for (const task of newlyFailed) {
      // Send failure notification
      await this.routeFailureNotification(task);

      // Apply failure behavior
      const behavior = task.taskDef.failureBehavior;

      if (behavior === "abort") {
        await this.abortWorkflow(task);
        return; // abort is terminal, stop processing
      } else if (behavior === "pause") {
        this.paused = true;
      }
      // "continue" — no special action, markBlockedTasks handles downstream
    }
  }

  private async routeFailureNotification(task: TaskState): Promise<void> {
    if (!this.notifications) return;

    const notification = task.taskDef.failureNotification;
    if (notification === "silent") return;

    const message = formatFailureMessage(task);

    if (notification.kind === "notify-parent") {
      await this.notifications.sendNotification(this.opts!.replyTo, message);
    } else if (notification.kind === "notify-target") {
      await this.notifications.sendNotification(notification.targetId, message);
    }
  }

  private async abortWorkflow(triggerTask: TaskState): Promise<void> {
    const wf = this.workflow!;

    // Kill all in-progress tasks
    for (const task of wf.tasks) {
      if (task.status === "in_progress" && task.sessionKey) {
        if (this.killer) {
          await this.killer.kill(task.sessionKey);
        }
        task.status = "failed";
        task.error = "aborted: workflow aborted due to task failure";
        task.completedAt = Date.now();
      }
    }

    // Mark all pending tasks as failed
    for (const task of wf.tasks) {
      if (task.status === "pending") {
        task.status = "failed";
        task.error = "aborted: workflow aborted due to task failure";
        task.completedAt = Date.now();
      }
    }
  }

  private markBlockedTasks(): void {
    const wf = this.workflow!;
    const tm = taskMap(wf.tasks);

    for (const task of wf.tasks) {
      if (task.status === "pending" && isBlocked(task.taskDef.id, wf.graph, tm)) {
        task.status = "failed";
        task.error = "blocked: dependency failed";
        task.completedAt = Date.now();
      }
    }
  }

  private async spawnReadyTasks(): Promise<void> {
    const wf = this.workflow!;
    const opts = this.opts!;
    const tm = taskMap(wf.tasks);

    for (const task of wf.tasks) {
      if (task.status !== "pending") continue;

      const deps = wf.graph.get(task.taskDef.id);
      if (!deps) continue; // task not in graph — skip

      // All deps must be done
      const allDepsDone = [...deps].every((depId) => {
        const dep = tm.get(depId);
        return dep?.status === "done";
      });

      if (!allDepsDone) continue;

      // Resolve templates in prompt
      const resolvedPrompt = resolveTemplates(task.taskDef.prompt, tm);

      // Spawn — handle errors
      try {
        const sessionKey = await this.spawner.spawn({
          taskId: task.taskDef.id,
          prompt: resolvedPrompt,
          replyTo: opts.replyTo,
          timeoutMs: task.taskDef.runtimeLimitMs ?? opts.runtimeLimitMs,
          workflowId: this.workflow?.id,
        });

        task.status = "in_progress";
        task.sessionKey = sessionKey;
        task.startedAt = Date.now();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        task.status = "failed";
        task.error = errorMsg;
        task.completedAt = Date.now();

        // Pause orchestrator on spawn error
        this.paused = true;

        // Notify parent about spawn failure
        if (this.notifications) {
          await this.notifications.sendNotification(
            opts.replyTo,
            `Failed to spawn task ${task.taskDef.id}: ${errorMsg}`,
          );
        }

        // Stop trying to spawn more tasks
        return;
      }
    }
  }

  private async checkCompletion(): Promise<void> {
    const wf = this.workflow!;

    // When paused, don't check for completion — there may be pending tasks waiting
    if (this.paused) return;

    const allTerminal = wf.tasks.every((t) => isTerminal(t.status));

    if (allTerminal && !this.completed) {
      this.completed = true;
      this.stopPolling();

      // Post summary before notifying
      if (this.statusManager) {
        await this.statusManager.postSummary(wf);
      }

      const allSuccess = wf.tasks.every((t) => t.status === "done");
      this.notifier.notify(wf.id, allSuccess, { replyTo: this.opts?.replyTo ?? "" });
    }
  }
}
