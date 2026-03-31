// ---------------------------------------------------------------------------
// Process Manager — Type definitions
// ---------------------------------------------------------------------------

/** Current lifecycle state of a managed process. */
export type ProcessState =
  | "starting"
  | "running"
  | "exited"
  | "stopping"
  | "failed"
  | "dead";

/** Owner category for grouping and lifecycle scoping. */
export interface ProcessOwner {
  kind: "daemon" | "mcp-server" | "agent-tool" | "plugin" | "session";
  scopeId?: string;
}

/** Restart policy for a managed process. */
export interface RestartPolicy {
  mode: "never" | "on-failure" | "always";
  /** Max consecutive restart attempts before giving up. Default 5. */
  maxRetries?: number;
  /** Delay before first restart (ms). Default 1000. */
  initialDelayMs?: number;
  /** Backoff multiplier per consecutive failure. Default 2. */
  backoffMultiplier?: number;
  /** Maximum delay between restarts (ms). Default 30000. */
  maxDelayMs?: number;
  /** Window (ms) after which a running process resets the retry counter. Default 60000. */
  resetAfterMs?: number;
}

/** Health check configuration. */
export type HealthCheck =
  | { kind: "tcp"; port: number; host?: string; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "http"; url: string; expectedStatus?: number; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "exec"; command: string; args?: string[]; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "stdout-match"; pattern: string; timeoutMs?: number };

/** Stdio handling configuration. */
export interface StdioConfig {
  capture: "pipe" | "ignore" | "inherit";
  maxBufferBytes?: number;
  stdin?: boolean;
}

/** Resource limits for a managed process. */
export interface ResourceLimits {
  maxMemoryBytes?: number;
  maxRuntimeSeconds?: number;
}

/** Graceful shutdown configuration. */
export interface ShutdownConfig {
  signal?: NodeJS.Signals;
  graceMs?: number;
  preStop?: { command: string; args?: string[]; timeoutMs?: number };
}

/** Readiness gate — must succeed before dependents start. */
export type ReadinessGate =
  | { kind: "tcp"; port: number; host?: string; timeoutMs?: number }
  | { kind: "http"; url: string; expectedStatus?: number; timeoutMs?: number }
  | { kind: "stdout-match"; pattern: string; timeoutMs?: number };

/** Declarative description of a managed process. */
export interface ProcessSpec {
  id: string;
  label?: string;
  owner: ProcessOwner;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  uid?: number;
  gid?: number;
  restart: RestartPolicy;
  health?: HealthCheck;
  stdio?: StdioConfig;
  limits?: ResourceLimits;
  shutdown?: ShutdownConfig;
  dependsOn?: string[];
  ready?: ReadinessGate;
}
