// Types
export type {
  TaskStatus,
  FailureBehavior,
  FailureNotification,
  FailureNotificationSilent,
  FailureNotificationParent,
  FailureNotificationTarget,
  TaskDef,
  TaskState,
  TaskList,
  DependencyGraph,
  TemplateRef,
  TaskOutputRef,
  TaskSuccessRef,
} from "./types.js";

// Graph
export { parseGraph, validateGraph, getTransitiveDeps } from "./graph.js";

// Templates
export {
  parseTemplateRefs,
  validateTemplateRefs,
  resolveTemplates,
} from "./templates.js";

// Depth
export { canSpawn } from "./depth.js";

// State persistence
export {
  saveWorkflow,
  loadWorkflow,
  deleteWorkflow,
  listIncompleteWorkflows,
  listAllWorkflows,
  type SerializedWorkflow,
} from "./state.js";

// Orchestrator
export {
  Orchestrator,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type NotificationAdapter,
  type KillAdapter,
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "./orchestrator.js";

// Server (procman integration)
export { FanOutServer, type FanOutServerOptions } from "./server.js";

// Duration formatting
export { formatDuration } from "./format.js";

// Status messaging
export { formatStatusMessage, formatSummaryMessage } from "./status-message.js";
export type { MessageAdapter } from "./message-adapter.js";
export { StatusManager } from "./status-manager.js";

// Control plane
export { ControlPlane, type ControlPlaneOptions, type WorkflowSummary } from "./control.js";

// Retention
export {
  retentionRun,
  startRetentionSchedule,
  stopRetentionSchedule,
  COMPLETED_MAX_AGE_MS,
  PAUSED_MAX_AGE_MS,
  type RetentionSummary,
  type RetentionOptions,
} from "./retention.js";

// Tool descriptor & handler
export { buildFanOutToolDescriptor, type FanOutToolDescriptor } from "./tool-descriptor.js";
export {
  handleFanOutToolCall,
  type FanOutToolArgs,
  type FanOutToolResult,
  type FanOutToolHandlerDeps,
} from "./tool-handler.js";

// Hardening
export {
  isValidTransition,
  guardedTransition,
  createTickLock,
  detectOrphans,
  detectAndPersistOrphans,
  type OrphanResult,
} from "./hardening.js";
