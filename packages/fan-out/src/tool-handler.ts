import type { TaskDef, FailureBehavior, FailureNotification } from "./types.js";
import type { FanOutServer } from "./server.js";
import type { ControlPlane } from "./control.js";
import type { OrchestratorOptions } from "./orchestrator.js";

// --- Input types (from tool call args) ---

interface TaskInput {
  id: number;
  prompt: string;
  failure_behavior?: "abort" | "pause" | "continue";
  failure_notification?: "silent" | { kind: "notify-parent" } | { kind: "notify-target"; target_id: string };
  runtime_limit_ms?: number;
}

export interface FanOutToolArgs {
  action: "start" | "abort" | "pause" | "resume" | "status" | "list" | "post" | "edit" | "retry" | "retention" | "wait";
  // start
  name?: string;
  tasks?: TaskInput[];
  graph?: string;
  polling_interval_ms?: number;
  runtime_limit_ms?: number;
  reply_to?: string;
  // workflow targeting
  workflow_id?: string;
  // edit / retry
  task_id?: number;
  prompt?: string;
  failure_behavior?: "abort" | "pause" | "continue";
  failure_notification?: "silent" | { kind: "notify-parent" } | { kind: "notify-target"; target_id: string };
  // retry
  cascade?: boolean;
  // list
  agent_chain_id?: string;
  // wait
  timeout_ms?: number;
}

export interface FanOutToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface FanOutToolHandlerDeps {
  server: FanOutServer;
  controlPlane: ControlPlane;
  stateDir: string;
  /** Current spawn depth of the calling session. */
  currentDepth: number;
  maxDepth: number;
}

// --- Helpers ---

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value;
}

function normalizeFailureNotification(
  input?: "silent" | { kind: "notify-parent" } | { kind: "notify-target"; target_id: string },
): FailureNotification {
  if (!input || input === "silent") return "silent";
  if (input.kind === "notify-parent") return { kind: "notify-parent" };
  if (input.kind === "notify-target") return { kind: "notify-target", targetId: input.target_id };
  return "silent";
}

function toTaskDefs(inputs: TaskInput[]): TaskDef[] {
  return inputs.map((t) => ({
    id: t.id,
    prompt: t.prompt,
    failureBehavior: (t.failure_behavior ?? "continue") as FailureBehavior,
    failureNotification: normalizeFailureNotification(t.failure_notification),
    runtimeLimitMs: t.runtime_limit_ms,
  }));
}

/** Convert a DependencyGraph (Map<number, Set<number>>) to a JSON-safe object. */
function serializeGraph(graph: Map<number, Set<number>>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [taskId, deps] of graph) {
    out[String(taskId)] = [...deps];
  }
  return out;
}

// --- Handler ---

export async function handleFanOutToolCall(
  args: FanOutToolArgs,
  deps: FanOutToolHandlerDeps,
): Promise<FanOutToolResult> {
  try {
    switch (args.action) {
      case "start": {
        const tasks = requireField(args.tasks, "tasks");
        const graph = requireField(args.graph, "graph");
        const name = args.name ?? "unnamed-workflow";
        const replyTo = requireField(args.reply_to, "reply_to");

        const taskDefs = toTaskDefs(tasks);
        const opts: OrchestratorOptions = {
          stateDir: deps.stateDir,
          currentDepth: deps.currentDepth,
          maxDepth: deps.maxDepth,
          replyTo,
          pollingIntervalMs: args.polling_interval_ms ?? 10_000,
          runtimeLimitMs: args.runtime_limit_ms ?? 600_000,
          name,
        };

        const workflowId = await deps.server.start(taskDefs, graph, opts);
        return { ok: true, data: { workflow_id: workflowId, name } };
      }

      case "abort": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        await deps.controlPlane.abort(wfId);
        return { ok: true, data: { workflow_id: wfId, action: "aborted" } };
      }

      case "pause": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        await deps.controlPlane.pause(wfId);
        return { ok: true, data: { workflow_id: wfId, action: "paused" } };
      }

      case "resume": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        await deps.controlPlane.resume(wfId);
        return { ok: true, data: { workflow_id: wfId, action: "resumed" } };
      }

      case "status": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        const wf = await deps.controlPlane.status(wfId);
        return { ok: true, data: { ...wf, graph: serializeGraph(wf.graph) } };
      }

      case "list": {
        const summaries = await deps.controlPlane.list(args.agent_chain_id);
        return { ok: true, data: summaries };
      }

      case "post": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        await deps.controlPlane.post(wfId);
        return { ok: true, data: { workflow_id: wfId, action: "posted" } };
      }

      case "edit": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        const taskId = requireField(args.task_id, "task_id");
        const updates: Record<string, unknown> = {};
        if (args.prompt !== undefined) updates.prompt = args.prompt;
        if (args.failure_behavior !== undefined) updates.failureBehavior = args.failure_behavior;
        if (args.failure_notification !== undefined) {
          updates.failureNotification = normalizeFailureNotification(args.failure_notification);
        }
        if (args.runtime_limit_ms !== undefined) updates.runtimeLimitMs = args.runtime_limit_ms;

        await deps.controlPlane.edit(wfId, taskId, updates);
        return { ok: true, data: { workflow_id: wfId, task_id: taskId, action: "edited" } };
      }

      case "retry": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        const taskId = requireField(args.task_id, "task_id");
        await deps.controlPlane.retry(wfId, taskId, args.cascade);
        return { ok: true, data: { workflow_id: wfId, task_id: taskId, cascade: !!args.cascade, action: "retried" } };
      }

      case "retention": {
        const summary = await deps.controlPlane.retention();
        return { ok: true, data: summary };
      }

      case "wait": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        const wf = await deps.controlPlane.wait(wfId, args.timeout_ms);
        return { ok: true, data: { ...wf, graph: serializeGraph(wf.graph) } };
      }

      default:
        return { ok: false, error: `Unknown action: ${(args as { action: string }).action}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
