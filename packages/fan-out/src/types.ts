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
