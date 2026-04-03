// Task status lifecycle
export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "paused" | "skipped";

// What to do when a task fails
export type FailureBehavior = "abort" | "pause" | "continue";

// Who to notify on failure
export type FailureNotificationSilent = "silent";
export type FailureNotificationParent = { kind: "notify-parent" };
export type FailureNotificationTarget = { kind: "notify-target"; targetId: string };
export type FailureNotification =
  | FailureNotificationSilent
  | FailureNotificationParent
  | FailureNotificationTarget;

// --- Task definition: discriminated union by `kind` ---

/** Common fields shared by all task definition kinds. */
interface TaskDefBase {
  id: number;
  /** Optional display title for status/summary posts (max 60 chars). Falls back to truncated prompt. */
  title?: string;
  failureBehavior: FailureBehavior;
  failureNotification: FailureNotification;
  runtimeLimitMs?: number;
  /** Optional template to reshape task output before downstream consumption. */
  outputTemplate?: string;
}

/** Agent task — spawns a subagent session with a prompt. */
export interface AgentTaskDef extends TaskDefBase {
  kind: "agent";
  prompt: string;
}

/** Tool task — invokes an MCP tool directly (Phase 2). */
export interface ToolTaskDef extends TaskDefBase {
  kind: "tool";
  tool: string;
  args?: Record<string, unknown>;
}

/** Gate task — evaluates a condition expression (Phase 3). */
export interface GateTaskDef extends TaskDefBase {
  kind: "gate";
  condition: string;
}

/** Transform task — applies a template string (Phase 3). */
export interface TransformTaskDef extends TaskDefBase {
  kind: "transform";
  template: string;
}

/** Message task — posts a message to a channel (Phase 3). */
export interface MessageTaskDef extends TaskDefBase {
  kind: "message";
  message: string;
  channel?: string;
}

/** Discriminated union of all task definition kinds. */
export type TaskDef = AgentTaskDef | ToolTaskDef | GateTaskDef | TransformTaskDef | MessageTaskDef;

/** Return a human-readable label for any TaskDef (prompt text for agent, tool name for tool, etc.). */
export function getTaskPromptOrLabel(td: TaskDef): string {
  switch (td.kind) {
    case "agent":
      return td.prompt;
    case "tool":
      return td.title ?? `tool:${td.tool}`;
    case "gate":
      return td.title ?? `gate:${td.condition}`;
    case "transform":
      return td.title ?? `transform`;
    case "message":
      return td.title ?? td.message;
  }
}

/** Adapter for executing tool calls directly (no subagent session). */
export interface ToolExecutor {
  execute(tool: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    output: string;
    error?: string;
  }>;
}

// Task runtime state
export interface TaskState {
  taskDef: TaskDef;
  status: TaskStatus;
  sessionKey?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  /** Set after failure behavior has been processed to prevent re-handling on subsequent ticks. */
  failureHandled?: boolean;
}

// Parsed dependency graph: task ID → set of dependency task IDs
export type DependencyGraph = Map<number, Set<number>>;

// A full task list / workflow
export interface TaskList {
  id: string;
  name: string;
  tasks: TaskState[];
  graph: DependencyGraph;
  pollingIntervalMs: number;
  createdAt: number;
  /** Max number of simultaneously in_progress tasks. undefined/0 = unlimited. */
  concurrency?: number;
  /** Default per-task runtime limit in ms. Persisted for resume. */
  runtimeLimitMs?: number;
}

// Template reference types
export interface TaskOutputRef {
  kind: "output";
  taskId: number;
}

export interface TaskSuccessRef {
  kind: "success";
  taskId: number;
}

export type TemplateRef = TaskOutputRef | TaskSuccessRef;

/** Minimal structured logger for workflow internals. */
