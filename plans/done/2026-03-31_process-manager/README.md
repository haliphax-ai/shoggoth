---
date: 2026-03-31
completed: 2026-03-31
---

# Plan: Process Manager Layer

A centralized subsystem for spawning, monitoring, communicating with, and reaping subprocesses on behalf of other Shoggoth components. Enables tools, plugins, MCP servers, and future extensions to be backed by long-running daemons.

## Motivation

Subprocess spawning is currently scattered across multiple code paths with no unified lifecycle management:

- **`os-exec`** — `runAsUser` / `spawnAsUser` for agent tool calls. Background handles tracked in a flat `Map` with no restart, health, or cleanup logic.
- **`mcp-jsonrpc-transport`** — `connectMcpStdioSession` spawns MCP server processes directly via `child_process.spawn`. No centralized tracking; cleanup is ad-hoc (SIGTERM → 5s grace → SIGKILL on session close).
- **Agent turns** — one-shot tool exec processes are fire-and-forget from the daemon's perspective.

There is no way for a tool or plugin to declare "I need a sidecar daemon running while I'm active" or "start this server and route requests to it." The process manager fills that gap.

## Design Principles

1. **Single owner** — all child processes go through the process manager. No direct `spawn()` calls elsewhere.
2. **Declarative specs** — callers describe *what* they want running (command, env, restart policy, health check). The manager handles *how*.
3. **Observable** — every managed process has a well-defined state machine, emits lifecycle events, and exposes structured logs.
4. **Graceful shutdown** — the manager owns the shutdown sequence. Processes are stopped in dependency order with configurable drain/grace periods.
5. **Prototype-grade** — no backward compat burden. Interfaces can change freely until v1.

## Terminology

| Term | Meaning |
|---|---|
| **Managed Process (MP)** | A subprocess whose full lifecycle is owned by the process manager. |
| **Spec** | Declarative description of a managed process (command, env, restart policy, health, etc.). |
| **Handle** | Runtime reference to a running MP — exposes state, output, IPC channels. |
| **Owner** | The component that requested the MP (e.g. an MCP server config, a tool plugin, the daemon core). |
| **Process Group** | A set of MPs that share a lifecycle (start together, stop together). |

## State Machine

```
         spawn()
           │
           ▼
       ┌────────┐
       │Starting │──── health check timeout ───▶ Failed
       └────┬───┘
            │ healthy / no health check
            ▼
       ┌────────┐
       │Running  │◀─── restart (if policy allows)
       └────┬───┘          │
            │ exit         │
            ▼              │
       ┌────────┐          │
       │Exited  │──────────┘
       └────┬───┘
            │ no restart / max retries
            ▼
       ┌────────┐
       │Dead    │
       └────────┘

  stop() from any state → Stopping → Dead
```

States: `starting` → `running` → `exited` → `dead` (terminal), with `stopping` and `failed` as intermediate/terminal states.

## Spec Schema

```typescript
interface ProcessSpec {
  /** Unique identifier for this spec (e.g. "mcp:filesystem", "plugin:lsp-server"). */
  id: string;

  /** Human-readable label for logs and status output. */
  label?: string;

  /** Owner category for grouping and lifecycle scoping. */
  owner: ProcessOwner;

  /** Command and arguments. */
  command: string;
  args?: string[];

  /** Working directory (absolute). */
  cwd?: string;

  /** Environment variables merged with the daemon's env. */
  env?: Record<string, string>;

  /** UID/GID for the child process (defaults to agent identity). */
  uid?: number;
  gid?: number;

  /** Restart policy. */
  restart: RestartPolicy;

  /** Health check configuration. Process is not considered "running" until healthy. */
  health?: HealthCheck;

  /** Stdio handling. */
  stdio?: StdioConfig;

  /** Resource limits. */
  limits?: ResourceLimits;

  /** Graceful shutdown configuration. */
  shutdown?: ShutdownConfig;

  /** Dependencies — IDs of other specs that must be running before this one starts. */
  dependsOn?: string[];

  /**
   * Readiness gate — optional callback or port probe that must succeed
   * before dependents are started.
   */
  ready?: ReadinessGate;
}
```

### Owner

```typescript
interface ProcessOwner {
  /** Category of the owner. */
  kind: "daemon" | "mcp-server" | "agent-tool" | "plugin" | "session";

  /**
   * Scoping identifier within the category.
   * - daemon: undefined (singleton)
   * - mcp-server: server config ID
   * - agent-tool: tool name
   * - plugin: plugin ID
   * - session: session ID (process dies when session ends)
   */
  scopeId?: string;
}
```

### Restart Policy

```typescript
interface RestartPolicy {
  /** "never" | "on-failure" | "always" */
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
```

### Health Check

```typescript
type HealthCheck =
  | { kind: "tcp"; port: number; host?: string; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "http"; url: string; expectedStatus?: number; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "exec"; command: string; args?: string[]; intervalMs?: number; timeoutMs?: number; retries?: number }
  | { kind: "stdout-match"; pattern: string; timeoutMs?: number };
```

`stdout-match` is useful for processes that print a "ready" line (e.g. "Listening on port 3000"). The manager watches stdout for the pattern and transitions to `running` on match.

### Stdio Config

```typescript
interface StdioConfig {
  /** What to do with stdout/stderr. */
  capture: "pipe" | "ignore" | "inherit";

  /**
   * When "pipe", max bytes to buffer in the ring buffer per stream.
   * Older output is discarded. Default 1MB.
   */
  maxBufferBytes?: number;

  /** When true, stdin is piped and writable via the handle. */
  stdin?: boolean;
}
```

### Resource Limits

```typescript
interface ResourceLimits {
  /** Max RSS in bytes. Process is killed if exceeded (checked periodically). */
  maxMemoryBytes?: number;

  /** Max wall-clock runtime in seconds. 0 = unlimited. */
  maxRuntimeSeconds?: number;
}
```

### Shutdown Config

```typescript
interface ShutdownConfig {
  /** Signal to send first. Default SIGTERM. */
  signal?: NodeJS.Signals;

  /** Grace period (ms) before escalating to SIGKILL. Default 5000. */
  graceMs?: number;

  /** Optional command to run before sending the signal (e.g. a drain endpoint). */
  preStop?: { command: string; args?: string[]; timeoutMs?: number };
}
```

### Readiness Gate

```typescript
type ReadinessGate =
  | { kind: "tcp"; port: number; host?: string; timeoutMs?: number }
  | { kind: "http"; url: string; expectedStatus?: number; timeoutMs?: number }
  | { kind: "stdout-match"; pattern: string; timeoutMs?: number };
```

## Handle API

```typescript
interface ProcessHandle {
  /** The spec this handle was created from. */
  readonly spec: ProcessSpec;

  /** Current state. */
  readonly state: "starting" | "running" | "exited" | "stopping" | "failed" | "dead";

  /** OS PID (undefined if not yet spawned or already dead). */
  readonly pid: number | undefined;

  /** Uptime of the current incarnation in ms. */
  readonly uptimeMs: number;

  /** Number of times this process has been restarted. */
  readonly restartCount: number;

  /** Exit code of the last incarnation (undefined if still running or never started). */
  readonly lastExitCode: number | null;

  /** Last exit signal. */
  readonly lastSignal: NodeJS.Signals | null;

  /** Read recent stdout/stderr from the ring buffer. */
  readOutput(stream: "stdout" | "stderr", options?: { tail?: number; since?: number }): string;

  /** Write to stdin (only if spec.stdio.stdin is true). */
  writeStdin(data: string | Buffer): void;

  /** Subscribe to lifecycle events. */
  on(event: "state-change", listener: (newState: string, oldState: string) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "stdout" | "stderr", listener: (chunk: Buffer) => void): void;

  /** Request a graceful stop. Returns a promise that resolves when the process is dead. */
  stop(): Promise<void>;

  /** Force kill (SIGKILL). */
  kill(): void;

  /** Trigger an immediate restart (stop + start). */
  restart(): Promise<void>;
}
```

## Process Manager API

```typescript
interface ProcessManager {
  /** Register and start a managed process. Returns a handle. */
  start(spec: ProcessSpec): Promise<ProcessHandle>;

  /** Stop a managed process by spec ID. */
  stop(id: string): Promise<void>;

  /** Stop all managed processes (shutdown sequence). */
  stopAll(): Promise<void>;

  /** Get a handle by spec ID. */
  get(id: string): ProcessHandle | undefined;

  /** List all managed processes. */
  list(): ProcessHandle[];

  /** List processes filtered by owner. */
  listByOwner(owner: Partial<ProcessOwner>): ProcessHandle[];

  /** Stop all processes scoped to a specific owner (e.g. when a session ends). */
  stopByOwner(owner: Partial<ProcessOwner>): Promise<void>;

  /** Subscribe to manager-level events. */
  on(event: "process-started", listener: (handle: ProcessHandle) => void): void;
  on(event: "process-stopped", listener: (handle: ProcessHandle) => void): void;
  on(event: "process-failed", listener: (handle: ProcessHandle, error: Error) => void): void;
}
```

## Package Placement

New package: `@shoggoth/procman`

Rationale: the process manager is a foundational layer that `daemon`, `os-exec`, and `mcp-integration` all depend on. Keeping it in its own package enforces clean boundaries and prevents circular deps.

Dependency graph after:
```
daemon ──▶ procman ──▶ (node:child_process, node:net)
os-exec ──▶ procman
mcp-integration ──▶ procman
```

## Migration Path

### Phase 1: Core process manager

- Implement `ProcessManager`, `ProcessSpec`, `ProcessHandle` in `@shoggoth/procman`.
- State machine, restart logic, health checks, ring-buffer output capture, graceful shutdown.
- Unit tests for state transitions, restart backoff, health check flows, shutdown ordering.

### Phase 2: MCP server integration

- Refactor `connectMcpStdioSession` to spawn via the process manager instead of raw `child_process.spawn`.
- MCP server configs in `shoggoth.json` become process specs with `owner.kind = "mcp-server"`.
- Health check: `stdout-match` for stdio servers, `tcp`/`http` for network servers.
- Restart policy: `on-failure` with backoff (MCP servers should auto-recover).
- Daemon shutdown stops MCP servers in reverse dependency order.

### Phase 3: os-exec migration

- Refactor `spawnAsUser` background sessions to register with the process manager.
- One-shot `runAsUser` calls can remain direct (they're short-lived and don't need lifecycle management), but should go through procman for unified tracking.
- Remove the ad-hoc `backgroundSessions` Map from `tools.ts` — the process manager becomes the single registry.
- `toolPoll` queries the process manager instead of the local Map.

### Phase 4: Plugin / tool daemon support

- Extend the config schema to allow tools and plugins to declare sidecar processes.
- The daemon starts declared sidecars on boot (or on first use, depending on config).
- Session-scoped processes (`owner.kind = "session"`) are automatically stopped when the session ends.
- Expose a `procman` control op and so agents can inspect running processes via the CLI (`shoggoth procman list`, `shoggoth procman restart <id>`) and a `procman` tool.

## Daemon Shutdown Sequence

When the daemon receives SIGTERM/SIGINT:

1. Stop accepting new requests.
2. Abort in-flight agent turns (existing behavior).
3. `processManager.stopAll()`:
   a. Build a reverse-dependency order from `dependsOn` edges.
   b. Stop leaf processes first, working back to roots.
   c. Each process follows its `ShutdownConfig` (preStop → signal → grace → SIGKILL).
   d. Timeout the entire sequence (configurable, default 30s). SIGKILL stragglers.
4. Close the database.
5. Exit.

## Observability

- Structured JSON log lines for every state transition: `{ level, msg, processId, state, prevState, pid, restartCount, ts }`.
- The `shoggoth procman list` CLI command shows a table: ID, state, PID, uptime, restarts, owner.
- Future: expose metrics (process count by state, restart rate, memory usage) for monitoring.

## Considerations

1. **Process groups vs. cgroups** — currently using `detached: true` + negative-PID kill for group cleanup. Should procman use cgroups (via `cgroupfs`) for harder isolation and memory limits? Not required for prototype but worth noting for future phases.
2. **IPC beyond stdio** — some sidecars may want structured IPC (Unix socket, named pipe). procman provide a convention (e.g. `SHOGGOTH_IPC_SOCKET=/run/shoggoth/proc/<id>.sock`) for these situations.
