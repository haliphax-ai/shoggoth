import { randomUUID } from "node:crypto";
import type { TaskDef, TaskState, TaskList, DependencyGraph, ToolExecutor } from "./types.js";
import { getTaskPromptOrLabel } from "./types.js";
import { parseGraph, validateGraph } from "./graph.js";
import { parseTemplateRefs, validateTemplateRefs, resolveTemplates } from "./templates.js";
import { canSpawn } from "./depth.js";
import { saveWorkflow, loadWorkflow } from "./state.js";
import { buildGateContext, evaluateGateCondition } from "./gate-eval.js";
import type { StatusManager } from "./status-manager.js";
import { getLogger } from "@shoggoth/shared";
const log = getLogger("workflow");

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
  /** Actual completion timestamp (epoch ms). When absent, the orchestrator uses Date.now(). */
  completedAt?: number;
}

export interface SpawnAdapter {
  spawn(req: SpawnRequest): Promise<string>;
  /** Abort an in-flight task by session key. Optional — callers check before invoking. */
  abortTask?(sessionKey: string): void;
}

export interface PollAdapter {
  poll(sessionKey: string): Promise<PollResult>;
}

export interface NotifyAdapter {
  notify(workflowId: string, success: boolean, context?: { replyTo: string; aborted?: boolean }): Promise<void>;
}

export interface NotificationAdapter {
  sendNotification(target: string, message: string): Promise<void>;
}

export interface KillAdapter {
  kill(sessionKey: string): Promise<void>;
}

/** Posts a message to a session/channel. Used by message tasks. */
export interface MessagePoster {
  post(sessionId: string, message: string): Promise<void>;
}

export interface OrchestratorOptions {
  stateDir: string;
  currentDepth: number;
  maxDepth: number;
  replyTo: string;
  pollingIntervalMs: number;
  runtimeLimitMs: number;
  name?: string;
  /** Max tasks running in parallel. undefined/0 = unlimited. */
  concurrency?: number;
}

// --- Helpers ---

function isTerminal(status: TaskState["status"]): boolean {
  return status === "done" || status === "failed" || status === "skipped";
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

/**
 * Check if a task should be skipped because at least one dependency was skipped.
 */
function shouldSkip(taskId: number, graph: DependencyGraph, tasks: Map<number, TaskState>): boolean {
  const deps = graph.get(taskId);
  if (!deps || deps.size === 0) return false;

  for (const depId of deps) {
    const dep = tasks.get(depId);
    if (!dep) continue;
    if (dep.status === "skipped") return true;
    if (dep.status === "pending" && shouldSkip(depId, graph, tasks)) return true;
  }
  return false;
}

/**
 * Get all transitive dependents of a task (tasks that depend on it, directly or transitively).
 */
function getTransitiveDependents(taskId: number, graph: DependencyGraph): Set<number> {
  // Build reverse graph: for each task, which tasks depend on it
  const reverse = new Map<number, Set<number>>();
  for (const [tid, deps] of graph) {
    for (const depId of deps) {
      if (!reverse.has(depId)) reverse.set(depId, new Set());
      reverse.get(depId)!.add(tid);
    }
  }

  const visited = new Set<number>();
  const stack = [...(reverse.get(taskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of reverse.get(current) ?? []) {
      stack.push(dep);
    }
  }
  return visited;
}

/** Resolve outputTemplate for a completed task, replacing self.* refs. */
function applyOutputTemplate(task: TaskState): void {
  if (!task.taskDef.outputTemplate || task.status !== "done") return;
  const tpl = task.taskDef.outputTemplate;
  const resolved = tpl
    .replace(/{{self.output}}/g, task.output ?? "")
    .replace(/{{self.error}}/g, task.error ?? "")
    .replace(/{{self.exitCode}}/g, "");
  task.output = resolved;
  // Clear to prevent re-application on subsequent ticks
  (task.taskDef as { outputTemplate?: string }).outputTemplate = undefined;
}

function formatFailureMessage(task: TaskState): string {
  const desc = getTaskPromptOrLabel(task.taskDef).slice(0, 100);
  return `Task ${task.taskDef.id} failed: "${desc}" — ${task.error ?? "unknown error"}`;
}

/** Extract the template-bearing string from a task def for ref validation. */
function getTemplateSources(task: TaskDef): string[] {
  switch (task.kind) {
    case "agent":
      return [task.prompt];
    case "transform":
      return [task.template];
    case "message":
      return [task.message];
    default:
      return [];
  }
}

// --- Orchestrator ---

export class Orchestrator {
  private readonly spawner: SpawnAdapter;
  private readonly poller: PollAdapter;
  private readonly notifier: NotifyAdapter;
  private readonly statusManager: StatusManager | null;
  private readonly notifications: NotificationAdapter | null;
  private readonly killer: KillAdapter | null;
  private readonly messagePoster: MessagePoster | null;
  private readonly toolExecutor: ToolExecutor | null;

  private workflow: TaskList | null = null;
  private opts: OrchestratorOptions | null = null;
  private completed = false;
  private paused = false;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    spawner: SpawnAdapter,
    poller: PollAdapter,
    notifier: NotifyAdapter,
    statusManager?: StatusManager,
    notifications?: NotificationAdapter,
    killer?: KillAdapter,
    messagePoster?: MessagePoster,
    toolExecutor?: ToolExecutor,
  ) {
    this.spawner = spawner;
    this.poller = poller;
    this.notifier = notifier;
    this.statusManager = statusManager ?? null;
    this.notifications = notifications ?? null;
    this.killer = killer ?? null;
    this.messagePoster = messagePoster ?? null;
    this.toolExecutor = toolExecutor ?? null;
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
      const sources = getTemplateSources(task);
      for (const source of sources) {
        const refs = parseTemplateRefs(source);
        if (refs.length > 0) {
          validateTemplateRefs(task.id, refs, graph);
        }
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
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      ...(opts.runtimeLimitMs ? { runtimeLimitMs: opts.runtimeLimitMs } : {}),
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

    log.info("workflow started", { workflowId: workflow.id, name: workflow.name, taskCount: tasks.length });

    return workflow.id;
  }

  /** Run a single poll/orchestration cycle. Used directly in tests. */
  async tick(): Promise<void> {
    if (!this.workflow || !this.opts || this.completed) {
      log.debug("tick skipped", { hasWorkflow: !!this.workflow, hasOpts: !!this.opts, completed: this.completed });
      return;
    }

    // Poll in-progress tasks (always, even when paused)
    await this.pollInProgress();

    // Check runtime limits
    await this.enforceRuntimeLimits();

    // Handle failures from this tick (collects notifications, doesn't send them yet)
    const pendingNotifications = await this.handleFailures();

    // Mark blocked pending tasks as failed (always, even when paused —
    // blocked tasks can never run regardless of pause state)
    this.markBlockedTasks();

    // Only spawn new tasks if not paused
    if (!this.paused) {
      // Spawn newly ready tasks
      await this.spawnReadyTasks();
    }

    // Apply output templates to newly completed tasks
    for (const task of this.workflow!.tasks) {
      applyOutputTemplate(task);
    }

    // Persist state
    saveWorkflow(this.opts.stateDir, this.workflow);

    // Status updates run on their own independent timer (see startStatusTimer).
    // No status update here — keeps the tick cycle decoupled from Discord API latency.

    // Dispatch failure notifications AFTER status post is updated
    const wfId = this.workflow.id;
    for (const task of pendingNotifications) {
      this.routeFailureNotification(task).catch((err) => {
        log.error("failure notification failed", { workflowId: wfId, taskId: task.taskDef.id, error: String(err) });
      });
    }

    // Check for completion
    await this.checkCompletion();
  }

  /** Start the automatic polling loop. */
  startPolling(): void {
    if (!this.workflow || !this.opts) return;
    const scheduleNext = () => {
      if (!this.workflow || !this.opts) {
        log.warn("polling loop stopped: missing workflow or opts", { hasWorkflow: !!this.workflow, hasOpts: !!this.opts });
        return;
      }
      this.pollingTimer = setTimeout(async () => {
        try {
          await this.tick();
        } catch (err) {
          log.error("tick failed", { workflowId: this.workflow?.id, error: String(err) });
        }
        if (this.pollingTimer !== null) scheduleNext();
      }, this.opts.pollingIntervalMs);
    };
    scheduleNext();
    this.startStatusTimer();
  }

  /** Start an independent timer for status post updates, decoupled from the tick cycle. */
  private startStatusTimer(): void {
    if (!this.statusManager || !this.workflow || !this.opts) return;
    this.statusTimer = setInterval(() => {
      if (!this.workflow || !this.statusManager) return;
      this.statusManager.updateStatus(this.workflow).catch((err) => {
        log.error("status timer updateStatus failed", { workflowId: this.workflow?.id, error: String(err) });
      });
    }, this.opts.pollingIntervalMs);
  }

  /** Stop the automatic polling loop. */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /** Whether the polling timer is active. */
  isPolling(): boolean {
    return this.pollingTimer !== null;
  }

  /** Whether the workflow has reached a terminal state. */
  isComplete(): boolean {
    return this.completed;
  }

  /** Whether the orchestrator is paused. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Get the status manager for this workflow, if any. */
  getStatusManager(): StatusManager | null {
    return this.statusManager;
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
        task.completedAt = result.completedAt ?? Date.now();
        log.debug("task completed", { workflowId: wf.id, taskId: task.taskDef.id });
        if (this.killer && task.sessionKey) {
          await this.killer.kill(task.sessionKey).catch(() => {});
        }
      } else if (result.status === "failed") {
        task.status = "failed";
        task.error = result.error;
        task.completedAt = result.completedAt ?? Date.now();
        log.debug("task failed", { workflowId: wf.id, taskId: task.taskDef.id, error: result.error });
        if (this.killer && task.sessionKey) {
          await this.killer.kill(task.sessionKey).catch(() => {});
        }
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
        // Abort the in-flight model turn
        this.spawner.abortTask?.(task.sessionKey);

        // Kill the session
        if (this.killer) {
          await this.killer.kill(task.sessionKey);
        }

        task.status = "failed";
        task.error = `timeout: task exceeded runtime limit of ${limit}ms`;
        task.completedAt = now;
        log.debug("task timed out", { workflowId: wf.id, taskId: task.taskDef.id, limitMs: limit });
      }
    }
  }

  /** Process failure behaviors and notifications for any newly failed tasks. */
  private async handleFailures(): Promise<TaskState[]> {
    const wf = this.workflow!;
    const opts = this.opts!;
    const notifyTasks: TaskState[] = [];

    // Collect tasks that just failed this tick (have completedAt set recently and are failed)
    // We process all failed tasks that haven't been handled yet.
    // To avoid re-processing, we check for tasks that are failed and have no special marker.
    // Simple approach: iterate and handle based on behavior. The abort/pause actions are idempotent.
    const newlyFailed = wf.tasks.filter(
      (t) => t.status === "failed" && t.completedAt !== undefined && !t.failureHandled && !t.error?.startsWith("blocked:") && !t.error?.startsWith("aborted:")
    );

    for (const task of newlyFailed) {
      task.failureHandled = true;

      // Apply failure behavior
      const behavior = task.taskDef.failureBehavior;

      if (behavior === "abort") {
        // Don't notify — the workflow is being aborted
        await this.abortWorkflow(task);
        return []; // abort is terminal, no notifications
      } else if (behavior === "pause") {
        this.paused = true;
      }
      // "continue" — no special action, markBlockedTasks handles downstream

      // Collect for notification after status post updates
      notifyTasks.push(task);
    }

    return notifyTasks;
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
        this.spawner.abortTask?.(task.sessionKey);
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
      if (task.status !== "pending") continue;

      // Check for skipped dependencies first — skip takes priority over block
      if (shouldSkip(task.taskDef.id, wf.graph, tm)) {
        task.status = "skipped";
        task.completedAt = Date.now();
        continue;
      }

      if (isBlocked(task.taskDef.id, wf.graph, tm)) {
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
    const concurrency = wf.concurrency ?? 0;

    for (const task of wf.tasks) {
      if (task.status !== "pending") continue;

      // Concurrency cap: count current in_progress tasks
      if (concurrency > 0) {
        const inProgress = wf.tasks.filter((t) => t.status === "in_progress").length;
        if (inProgress >= concurrency) break;
      }

      const deps = wf.graph.get(task.taskDef.id);
      if (!deps) continue; // task not in graph — skip

      // All deps must be done
      const allDepsDone = [...deps].every((depId) => {
        const dep = tm.get(depId);
        return dep?.status === "done";
      });

      if (!allDepsDone) continue;

      // --- Dispatch by task kind ---

      if (task.taskDef.kind === "gate") {
        // Evaluate gate condition synchronously
        const now = Date.now();
        task.startedAt = now;
        try {
          const ctx = buildGateContext(tm);
          const result = evaluateGateCondition(task.taskDef.condition, ctx);
          if (result) {
            task.output = "pass";
            task.status = "done";
            task.completedAt = Date.now();
            log.debug("gate task passed", { workflowId: wf.id, taskId: task.taskDef.id });
          } else {
            task.output = "skip";
            task.status = "done";
            task.completedAt = Date.now();
            log.debug("gate task skipped", { workflowId: wf.id, taskId: task.taskDef.id });

            // Propagate: mark all transitive dependents as skipped
            const dependents = getTransitiveDependents(task.taskDef.id, wf.graph);
            for (const depId of dependents) {
              const depTask = tm.get(depId);
              if (depTask && depTask.status === "pending") {
                depTask.status = "skipped";
                depTask.completedAt = Date.now();
              }
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          task.status = "failed";
          task.error = errorMsg;
          task.completedAt = Date.now();
        }
        continue;
      }

      if (task.taskDef.kind === "transform") {
        // Pure string interpolation — no subagent, no I/O
        const now = Date.now();
        task.startedAt = now;
        try {
          const resolved = resolveTemplates(task.taskDef.template, tm);
          task.output = resolved;
          task.status = "done";
          task.completedAt = Date.now();
          log.debug("transform task completed", { workflowId: wf.id, taskId: task.taskDef.id });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          task.status = "failed";
          task.error = errorMsg;
          task.completedAt = Date.now();
        }
        continue;
      }

      if (task.taskDef.kind === "message") {
        // Post a message to a channel — requires MessagePoster
        const now = Date.now();
        task.startedAt = now;
        if (!this.messagePoster) {
          task.status = "failed";
          task.error = "message task requires a MessagePoster but none was provided";
          task.completedAt = Date.now();
          continue;
        }
        try {
          const resolvedMessage = resolveTemplates(task.taskDef.message, tm);
          const target = task.taskDef.channel ?? opts.replyTo;
          await this.messagePoster.post(target, resolvedMessage);
          task.output = resolvedMessage;
          task.status = "done";
          task.completedAt = Date.now();
          log.debug("message task completed", { workflowId: wf.id, taskId: task.taskDef.id, target });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          task.status = "failed";
          task.error = errorMsg;
          task.completedAt = Date.now();
        }
        continue;
      }

      if (task.taskDef.kind === "tool") {
        const now = Date.now();
        task.startedAt = now;
        if (!this.toolExecutor) {
          task.status = "failed";
          task.error = "tool task requires a ToolExecutor but none was provided";
          task.completedAt = Date.now();
          continue;
        }
        try {
          const resolveArgsDeep = (val: unknown): unknown => {
            if (typeof val === "string") return resolveTemplates(val, tm);
            if (Array.isArray(val)) return val.map(resolveArgsDeep);
            if (val !== null && typeof val === "object") {
              const out: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
                out[k] = resolveArgsDeep(v);
              }
              return out;
            }
            return val;
          };
          const resolvedArgs = resolveArgsDeep(task.taskDef.args ?? {}) as Record<string, unknown>;
          const result = await this.toolExecutor.execute(task.taskDef.tool, resolvedArgs);
          if (result.ok) {
            task.output = result.output;
            task.status = "done";
          } else {
            task.status = "failed";
            task.error = result.error ?? "tool execution failed";
          }
          task.completedAt = Date.now();
          log.debug("tool task completed", { workflowId: wf.id, taskId: task.taskDef.id, ok: result.ok });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          task.status = "failed";
          task.error = errorMsg;
          task.completedAt = Date.now();
        }
        continue;
      }

      // --- Agent task: spawn subagent ---

      // Resolve templates in prompt (agent tasks only)
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
        log.debug("task started", { workflowId: wf.id, taskId: task.taskDef.id, sessionKey });
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

      // Clean up any remaining subagent sessions
      if (this.killer) {
        for (const task of wf.tasks) {
          if (task.sessionKey) {
            await this.killer.kill(task.sessionKey).catch(() => {});
          }
        }
      }

      // Post summary before notifying
      if (this.statusManager) {
        await this.statusManager.postSummary(wf);
      }

      const allSuccess = wf.tasks.every((t) => t.status === "done");
      const wasAborted = wf.tasks.some((t) => t.error?.startsWith("aborted:"));
      this.notifier.notify(wf.id, allSuccess, { replyTo: this.opts?.replyTo ?? "", aborted: wasAborted });
      if (allSuccess) {
        log.info("workflow completed", { workflowId: wf.id });
      } else {
        log.error("workflow failed", { workflowId: wf.id });
      }
    }
  }
}
