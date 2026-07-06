import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import type { TaskDef, FailureBehavior, FailureNotification } from "./types.js";
import type { WorkflowServer } from "./server.js";
import type { ControlPlane } from "./control.js";
import type { OrchestratorOptions } from "./orchestrator.js";

// --- Input types (from tool call args) ---

interface TaskInput {
  id: number;
  kind?: "agent" | "tool" | "gate" | "transform" | "message";
  prompt?: string;
  title?: string;
  failure_behavior?: "abort" | "pause" | "continue";
  failure_notification?:
    | "silent"
    | { kind: "notify-parent" }
    | { kind: "notify-target"; target_id: string };
  runtime_limit_ms?: number;
  tool?: string;
  args?: Record<string, unknown>;
  condition?: string;
  template?: string;
  message?: string;
  channel?: string;
  output_template?: string;
  response_schema?: {
    schema: Record<string, unknown>;
  };
  model_options?: { model?: string };
}

export interface WorkflowToolArgs {
  action:
    | "start"
    | "abort"
    | "pause"
    | "resume"
    | "status"
    | "list"
    | "post"
    | "edit"
    | "retry"
    | "retention";
  // start
  name?: string;
  tasks?: TaskInput[];
  graph?: string;
  polling_interval_ms?: number;
  runtime_limit_ms?: number;
  reply_to?: string;
  concurrency?: number;
  definition_file?: string;
  // workflow targeting
  workflow_id?: string;
  // edit / retry
  task_id?: number;
  prompt?: string;
  failure_behavior?: "abort" | "pause" | "continue";
  failure_notification?:
    | "silent"
    | { kind: "notify-parent" }
    | { kind: "notify-target"; target_id: string };
  // retry
  cascade?: boolean;
  // list
  agent_chain_id?: string;
}

export interface WorkflowToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface WorkflowToolHandlerDeps {
  server: WorkflowServer;
  controlPlane: ControlPlane;
  stateDir: string;
  /** Current spawn depth of the calling session. */
  currentDepth: number;
  maxDepth: number;
  /** Resolved workspace root. If omitted, derived from env/cwd. */
  workspaceRoot?: string;
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
  return inputs.map((t) => {
    const kind = t.kind ?? "agent";
    const base = {
      id: t.id,
      ...(t.title ? { title: t.title.slice(0, 60) } : {}),
      failureBehavior: (t.failure_behavior ?? "continue") as FailureBehavior,
      failureNotification: normalizeFailureNotification(t.failure_notification),
      runtimeLimitMs: t.runtime_limit_ms,
      ...(t.output_template ? { outputTemplate: t.output_template } : {}),
    };

    switch (kind) {
      case "agent": {
        const prompt = requireField(t.prompt, `tasks[${t.id}].prompt (required for agent task)`);
        return {
          ...base,
          kind: "agent" as const,
          prompt,
          ...(t.response_schema ? { responseSchema: t.response_schema } : {}),
          ...(t.model_options ? { modelOptions: t.model_options } : {}),
        };
      }
      case "tool": {
        const tool = requireField(t.tool, `tasks[${t.id}].tool (required for tool task)`);
        const args = requireField(t.args, `tasks[${t.id}].args (required for tool task)`);
        return { ...base, kind: "tool" as const, tool, args };
      }
      case "gate": {
        const condition = requireField(
          t.condition,
          `tasks[${t.id}].condition (required for gate task)`,
        );
        return { ...base, kind: "gate" as const, condition };
      }
      case "transform": {
        const template = requireField(
          t.template,
          `tasks[${t.id}].template (required for transform task)`,
        );
        return { ...base, kind: "transform" as const, template };
      }
      case "message": {
        const message = requireField(
          t.message,
          `tasks[${t.id}].message (required for message task)`,
        );
        return {
          ...base,
          kind: "message" as const,
          message,
          ...(t.channel ? { channel: t.channel } : {}),
        };
      }
      default:
        throw new Error(`Unknown task kind: ${kind}`);
    }
  });
}

/** Convert a DependencyGraph (Map<number, Set<number>>) to a JSON-safe object. */
function serializeGraph(graph: Map<number, Set<number>>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [taskId, deps] of graph) {
    out[String(taskId)] = [...deps];
  }
  return out;
}

/** Resolve the workspace root: dep > env var > cwd walk for .git > cwd */
function resolveWorkspaceRoot(provided?: string): string {
  if (provided) return provided;
  if (process.env.SHOGGOTH_WORKSPACE_ROOT) return process.env.SHOGGOTH_WORKSPACE_ROOT;
  // Walk up from cwd looking for .git
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(dir + "/.git")) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// --- Handler ---

export async function handleWorkflowToolCall(
  args: WorkflowToolArgs,
  deps: WorkflowToolHandlerDeps,
): Promise<WorkflowToolResult> {
  try {
    switch (args.action) {
      case "start": {
        let tasks = args.tasks;
        let graph = args.graph;
        let name = args.name;
        let pollingIntervalMs = args.polling_interval_ms;
        let runtimeLimitMs = args.runtime_limit_ms;
        let concurrency = args.concurrency;

        // --- definition_file handling ---
        if (args.definition_file !== undefined) {
          const filePath = args.definition_file;
          if (!isAbsolute(filePath)) {
            return { ok: false, error: "definition_file must be an absolute path" };
          }
          const resolvedPath = resolve(filePath);
          const workspaceRoot = resolveWorkspaceRoot(deps.workspaceRoot);
          if (!resolvedPath.startsWith(workspaceRoot)) {
            return {
              ok: false,
              error: `definition_file must be inside workspace (got "${resolvedPath}", workspace root is "${workspaceRoot}")`,
            };
          }
          let fileContents: string;
          try {
            fileContents = await readFile(filePath, "utf-8");
          } catch {
            return {
              ok: false,
              error: `definition_file not found: ${filePath}`,
            };
          }
          let parsed: {
            tasks?: TaskInput[];
            graph?: string;
            name?: string;
            polling_interval_ms?: number;
            runtime_limit_ms?: number;
            concurrency?: number;
            reply_to?: string;
          };
          try {
            parsed = JSON.parse(fileContents);
          } catch (err) {
            return {
              ok: false,
              error: `definition_file JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          // Merge: file wins for tasks/graph/name/polling_interval_ms/runtime_limit_ms/concurrency
          // reply_to from file is ignored (inline reply_to always wins)
          tasks = parsed.tasks ?? tasks;
          graph = parsed.graph ?? graph;
          name = parsed.name ?? name;
          pollingIntervalMs = parsed.polling_interval_ms ?? pollingIntervalMs;
          runtimeLimitMs = parsed.runtime_limit_ms ?? runtimeLimitMs;
          concurrency = parsed.concurrency ?? concurrency;
        }
        // --- end definition_file handling ---

        const finalTasks = requireField(tasks, "tasks");
        const finalGraph = requireField(graph, "graph");
        const finalName = name ?? "unnamed-workflow";
        const replyTo = requireField(args.reply_to, "reply_to");

        const taskDefs = toTaskDefs(finalTasks);
        const opts: OrchestratorOptions = {
          stateDir: deps.stateDir,
          currentDepth: deps.currentDepth,
          maxDepth: deps.maxDepth,
          replyTo,
          pollingIntervalMs: pollingIntervalMs ?? 10_000,
          runtimeLimitMs: runtimeLimitMs ?? 600_000,
          name: finalName,
          ...(concurrency ? { concurrency } : {}),
        };

        const workflowId = await deps.server.start(taskDefs, finalGraph, opts);
        return { ok: true, data: { workflow_id: workflowId, name: finalName } };
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

        // Add duration field to each task
        const now = Date.now();
        const tasksWithDuration = wf.tasks.map((task) => {
          if (task.startedAt == null) {
            return task;
          }
          const duration = task.completedAt != null
            ? task.completedAt - task.startedAt
            : now - task.startedAt;
          return { ...task, duration };
        });

        return {
          ok: true,
          data: { ...wf, tasks: tasksWithDuration, graph: serializeGraph(wf.graph) },
        };
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
        return {
          ok: true,
          data: { workflow_id: wfId, task_id: taskId, action: "edited" },
        };
      }

      case "retry": {
        const wfId = requireField(args.workflow_id, "workflow_id");
        const taskId = requireField(args.task_id, "task_id");
        await deps.controlPlane.retry(wfId, taskId, args.cascade);
        return {
          ok: true,
          data: {
            workflow_id: wfId,
            task_id: taskId,
            cascade: !!args.cascade,
            action: "retried",
          },
        };
      }

      case "retention": {
        const summary = await deps.controlPlane.retention();
        return { ok: true, data: summary };
      }

      default:
        return {
          ok: false,
          error: `Unknown action: ${(args as { action: string }).action}`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}