// ---------------------------------------------------------------------------
// @shoggoth/procman — public API
// ---------------------------------------------------------------------------

export type {
  ProcessSpec,
  ProcessOwner,
  ProcessState,
  RestartPolicy,
  HealthCheck,
  StdioConfig,
  ResourceLimits,
  ShutdownConfig,
  ReadinessGate,
} from "./types.js";

export { RingBuffer } from "./ring-buffer.js";
export { ManagedProcess } from "./managed-process.js";
export { ProcessManager } from "./process-manager.js";
