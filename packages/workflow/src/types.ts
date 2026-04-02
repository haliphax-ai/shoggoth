// Task status lifecycle
export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "paused";

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

// Task definition — the static spec for a task
export interface TaskDef {
  id: number;
  prompt: string;
  /** Optional display title for status/summary posts (max 60 chars). Falls back to truncated prompt. */
  title?: string;
  failureBehavior: FailureBehavior;
  failureNotification: FailureNotification;
  runtimeLimitMs?: number;
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
