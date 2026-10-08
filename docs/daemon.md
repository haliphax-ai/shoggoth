# Shoggoth Daemon Reference

The Shoggoth daemon is the long-running core process that orchestrates agent sessions, model interactions, tool execution, platform messaging, and operator control. It is the single entry point for all agent activity within a Shoggoth deployment.

---

## Architecture Overview

The daemon boots as a single Node.js process (`src/index.ts`) and wires together the following subsystems in order:

1. **Configuration** — layered JSON config loaded from `SHOGGOTH_CONFIG_DIR` (or the default layout directory). A `configRef` is held in memory and updated by hot-reload. See [Shared](shared.md#configuration-schema) for the full schema and [Shared](shared.md#layered-config-loader) for the merge algorithm.
2. **State Database** — a SQLite database (see [Shared](shared.md) for schema types) (WAL mode, `better-sqlite3`) storing sessions, transcripts, events, timers, tool runs, elevation grants, HITL pending actions, audit log, KV store, and more.
3. **Migrations** — numbered `.sql` files applied at startup via `migrate()`. A `_schema_migrations` table tracks applied versions.
4. **Bootstrap Main Session** — ensures the primary agent's workspace directory and session row exist. The session URN is derived from the agent's first configured platform route.
5. **Control Plane** — a Unix domain socket server for operator and agent control operations (authenticated, policy-gated). See [CLI](cli.md) for the operator-facing command interface.
6. **Config Hot-Reload** — watches the config directory for changes and live-applies policy and HITL slices without restart.
7. **Timer Scheduler** — restores persisted timers from the DB, fires past-due ones, and schedules future ones via a min-heap.
8. **Process Manager** — starts declared boot-time processes and manages their lifecycle.
9. **Turn Queue** — a tiered priority queue (system/user) with anti-starvation, per-session serialization.
10. **Model Resilience Gate** — retry/concurrency limiter for model API calls (see [Models](models.md)).
11. **Workflow Engine** — resumes incomplete workflows and provides the `builtin-workflow` tool (see [Workflow](workflow.md)).
12. **Platform (Discord)** — connects to Discord for messaging, reactions, HITL approval, and streaming replies (see [Platform Discord](platform-discord.md)).
13. **Event Loops** — periodic heartbeat, cron, and retention ticks.
14. **Health Registry** — probes for SQLite, Discord, model endpoint, and embeddings endpoint readiness.
15. **Shutdown Coordinator** — graceful drain of all subsystems on SIGTERM/SIGINT.

### Runtime Object

`createDaemonRuntime()` produces a `DaemonRuntime` containing:

- `health: HealthRegistry` — register probes, take snapshots.
- `shutdown: ShutdownCoordinator` — register drain functions, request shutdown.
- `getHealth()` — async snapshot of all probes.
- `disposeSignals()` — unhook OS signal handlers.

---

## State Database

Opened via `openStateDb()` with pragmas:

| Pragma         | Value                  |
| -------------- | ---------------------- |
| `journal_mode` | WAL                    |
| `synchronous`  | NORMAL                 |
| `foreign_keys` | ON                     |
| `busy_timeout` | 5000 ms (configurable) |

Migrations live in `shoggoth/migrations/` as numbered SQL files (e.g. `0001_initial.sql`). The `_schema_migrations` table prevents re-application. Migrations run inside immediate transactions.

### Key Tables

| Table                            | Purpose                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                       | Session rows (id, workspace, status, context segment, model selection, context level, working directory, subagent metadata, system context token) |
| `transcript_messages`            | Per-session message history scoped by `context_segment_id`                                                                                        |
| `tool_runs`                      | Tracks running/completed/failed tool loop executions                                                                                              |
| `events`                         | Durable event queue (pending → processing → completed/dead)                                                                                       |
| `event_processing_done`          | At-least-once consumer idempotency                                                                                                                |
| `cron_jobs`                      | Scheduled recurring jobs                                                                                                                          |
| `timers`                         | Deferred timer actions (fire_at, message, session)                                                                                                |
| `elevation_grants`               | Time-limited elevated execution grants                                                                                                            |
| `pending_actions`                | HITL approval queue                                                                                                                               |
| `hitl_session_tool_auto_approve` | Per-session tool auto-approve state                                                                                                               |
| `session_tool_state`             | Tool discovery enable/disable state per session                                                                                                   |
| `session_stats`                  | Token usage, turn counts, compaction counts                                                                                                       |
| `kv_store`                       | Per-workspace key-value store                                                                                                                     |
| `audit_log`                      | Append-only audit trail                                                                                                                           |
| `agent_tokens`                   | Hashed agent authentication tokens                                                                                                                |
| `acpx_bindings`                  | ACPX process bindings                                                                                                                             |

---

## Sessions

### Session Store

`createSessionStore(db)` provides CRUD over the `sessions` table. Each session row contains:

- `id` — a URN like `agent:main:discord:channel:<channelId>:<uuid>` (minted by `mintAgentSessionUrn`).
- `contextSegmentId` — a UUID scoping which transcript messages the model sees. Changed on `new`/`reset` operations.
- `systemContextToken` — a per-session anti-spoofing token embedded in trusted system context dividers to prevent prompt injection.
- `contextLevel` — one of `none`, `minimal`, `light`, `full`. Controls system prompt assembly and tool surface.
- `workingDirectory` — per-session CWD override (relative commands resolve against this).
- `status` — `starting`, `active`, or `terminated`.
- `modelSelection` — JSON blob for per-session model override.
- `subagentMode` — `one_shot` or `persistent` (for child sessions).
- `parentSessionId` — links subagent sessions to their parent.

### Session Manager

`createSessionManager()` handles:

- `spawn(input)` — mints a session URN, creates the workspace layout, inserts the session row, registers an agent token. Subagent sessions inherit the parent's working directory.
- `kill(sessionId)` — revokes the agent token and sets status to `terminated`.
- `rotateAgentToken(sessionId)` — mints a new token for an existing session.
- `attachPromptStack` / `setLightContext` — update session metadata.

### Context Segments

Context segments (`sessions.context_segment_id`) scope transcript messages for model context. Two operations exist:

- **New** (`applySessionContextSegmentNew`) — mints a new segment UUID, denies pending HITL actions, clears per-session tool auto-approve, kills all child subagents, resets session stats. Old transcript rows are abandoned (not deleted — retention handles cleanup).
- **Reset** (`applySessionContextSegmentReset`) — mints a new segment UUID and denies pending HITL, but retains auto-approvals and does not touch subagents.

Both push a "Fresh session" system context message.

---

## System Prompt Assembly

`buildSessionSystemContext()` assembles the model's system message based on the session's [`contextLevel`](shared.md#context-levels):

| Level     | Content                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `none`    | Empty string — raw model, no Shoggoth framing                                                                            |
| `minimal` | Trusted context guidance, runtime metadata, TOOLS.md only                                                                |
| `light`   | Above + workspace root, operator global instructions, AGENTS.md, env appendix                                            |
| `full`    | Above + all workspace template files (IDENTITY.md, USER.md, AGENTS.md, MEMORY.md, TOOLS.md, BOOTSTRAP.md), session stats |

Template files are read from the session workspace with symlink-escape protection. A per-file cap of 8 KB and total cap of 24 KB apply. If `BOOTSTRAP.md` exists at `full` level, only it is injected (bootstrapping flow).

The system prompt also includes:

- A human-readable UTC timestamp.
- Buffered system context entries (drained from `system-context-buffer`).
- Operator global instructions from the operator directory (`GLOBAL.md`).
- Runtime metadata line (session URN, host, OS, node version, model, capabilities).
- Session stats (context fill, turns, compactions, queue depth) at `full` level.

---

## Tool Loop

`runToolLoop()` is the core model interaction cycle:

1. Call `model.complete()` to get assistant text and/or tool calls.
2. If no tool calls, append assistant message to transcript and exit.
3. For each tool call:
   - Validate tool name (regex, thinking-leak detection).
   - Check the tool is in the allowed set.
   - Validate arguments against the tool's JSON schema.
   - Resolve compound resources (e.g. `exec:curl`) for policy/HITL.
   - Run policy check (deny → review → allow → default_deny).
   - Run configurable system gates (AGENTS.md discovery / re-read-required for configured external tools) — before HITL.
   - If HITL required: enqueue pending action, wait for approval/denial/timeout.
   - Execute the tool (with optional timeout).
   - Run the system-gates post hook (re-read line-shift producer).
   - Push result back to model context.
   - Record to transcript and emit stats.
4. Between tool call batches, drain any operator steer messages and inject them.
5. Check for mid-loop tool discovery refresh.
6. Loop back to step 1.

The loop respects a `turnAbortSignal` for cancellation and marks tool runs as failed on error.

### Tool Discovery

When `toolDiscovery.enabled` is true, the daemon maintains a collapsible tool catalog:

- Tools not in the `alwaysOn` set start collapsed (hidden from the model).
- The `builtin-discover` tool is always available and lists/enables/disables tools.
- Session enable entries may be exact tool IDs or glob patterns (`kanban-*`); an exact entry for a tool always wins over a glob match.
- Glob patterns are also allowed in `toolDiscovery.alwaysOn` (global config) and per-agent `toolDiscovery.alwaysOn` (subagent defaults); every catalog tool matching a glob is advertised as always-on.
- Trigger phrases in user messages can auto-enable tools.
- Mid-loop refresh updates the tool set without restarting the turn.
- Subagent spawns accept `enable_tools` (tool IDs/globs) which are added to the session's enabled set alongside the configured defaults.

### System Gates

Two system gates are hard-wired into specific builtin handlers: the **AGENTS.md discovery gate** (blocks tool execution until the agent reads project instructions) and the **re-read-required gate** (blocks edits using stale line numbers after file mutations). Historically these applied only to those `builtin-*` tools — MCP/external tools dispatched through the tool loop bypassed them.

The `gates` config section extends the same two gates to any tool whose namespaced name matches a glob list:

```jsonc
// config fragment
{
  "gates": {
    "agentsMd": { "tools": ["demo_ext-*"] },
    "reRead": { "tools": ["filesystem-write"] },
  },
}
```

- Glob matching targets the routed namespaced name (e.g. `demo_ext-edit`, `builtin-read`), consistent with `contextLevelTools` / `toolDiscovery.alwaysOn`.
- Defaults are empty tool lists — the feature is off until configured, and behavior is byte-identical to before for unlisted tools.
- Gate order in the tool loop: system gates run **before** HITL approval, so an approval-worthy external tool is gated first (avoids approving a call that then gets gated and re-prompted). A gated call returns the normal `{ gated: true, ... }` payload to the model; the model fixes the condition and retries.
- The re-read consumer scans any string values in the tool args as candidate paths (resolved against the working directory, restricted to the workspace); the re-read producer flags a file when the external tool changes its line count (mirrors `builtin-replace`). External reads do **not** clear flags — the gate message instructs `builtin-read`, which clears them.
- `deepMerge` replaces arrays, so a later config fragment replaces a `gates.*.tools` list wholesale.

### Builtin Tool Registry

`BuiltinToolRegistry` is a typed `Map<string, BuiltinToolHandler>` dispatching tool calls to handler functions. Each handler receives a `BuiltinToolContext` with the session's DB, config, workspace path, credentials, and more. Handlers are stateless — all per-invocation state flows through the context.

Registered builtins include: exec, fetch, fs operations, ls, cd, read/write, search-replace, kv, memory, message, session management, show, skills, timer, web-search, workflow, config, discover, elevate, and process manager operations.

---

## Transcript & Compaction

Transcripts are stored in `transcript_messages` scoped by `(session_id, context_segment_id)`. Each row has a monotonic `seq`, role, content, optional `tool_call_id`, and `tool_calls_json`.

`compactSessionTranscript()` triggers when the context window fills:

1. Load transcript for the current segment.
2. Strip image blocks and thinking blocks (avoid sending large payloads to the summarizer).
3. Call [`compactTranscriptIfNeeded()`](models.md#transcript-compaction) from `@shoggoth/models` with the compaction policy.
4. If compacted, replace the transcript rows and record the compaction in session stats.

Compaction uses a separate model call to summarize older messages, preserving recent ones.

---

## Control Plane

The control plane is a Unix domain socket server (`startControlPlane()`) using JSONL framing and the Shoggoth wire protocol.

### Authentication

- **Operator** — `operator_token` auth kind, validated against the operator secret.
- **Agent** — `agent_token` auth kind, validated against hashed tokens in `agent_tokens` table.
- **Health** endpoint is exempt from auth.

### Authorization

Every control op goes through the policy engine:

```
deny → review → allow → default_deny
```

Rules support wildcards (`*`), compound resources (`exec:*`, `exec:curl`), and per-agent overrides.

### Defined Control Operations

| Category | Operations                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System   | `ping`, `version`, `health`                                                                                                                                                                                                        |
| Agent    | `agent_ping`                                                                                                                                                                                                                       |
| Session  | `session_list`, `session_inspect`, `session_send`, `session_steer`, `session_abort`, `session_kill`, `session_model`, `session_compact`, `session_context_new`, `session_context_reset`, `session_context_status`, `session_stats` |
| Subagent | `subagent_spawn`                                                                                                                                                                                                                   |
| HITL     | `hitl_pending_list`, `hitl_pending_get`, `hitl_pending_approve`, `hitl_pending_deny`, `hitl_clear`                                                                                                                                 |
| Config   | `config_show`, `config_request`                                                                                                                                                                                                    |
| Process  | `procman_list`, `procman_restart`, `procman_stop`                                                                                                                                                                                  |
| ACPX     | `acpx_bind_get`, `acpx_bind_set`, `acpx_bind_delete`, `acpx_bind_list`, `acpx_agent_start`, `acpx_agent_stop`, `acpx_agent_list`                                                                                                   |
| MCP      | `mcp_http_cancel_request`                                                                                                                                                                                                          |

All operations are audited to the `audit_log` table.

---

## Policy Engine

`createPolicyEngine(config, agents)` builds a `PolicyEngine` that evaluates `PolicyCheckInput` (principal + action + resource) against configured rules.

### Principals

- `system` — always allowed.
- `operator` — checked against `policy.operator.controlOps` / `policy.operator.tools`.
- `agent` — checked against `policy.agent.controlOps` / `policy.agent.tools`, with optional per-agent overrides from `agents.list.<id>.policy.tools`.

### Rule Evaluation

Order: **deny → review → allow → default_deny**.

- `*` in allow permits anything not denied.
- `*` in deny blocks everything.
- Compound resources: `exec:curl` matches `exec:curl`, `exec:*`, bare `exec`, and `*`.
- `review` rules route to HITL instead of outright denial.

The engine is wrapped in a `DelegatingPolicyEngine` so hot-reload can swap the inner engine without recreating listeners.

---

## Human-in-the-Loop (HITL)

### Risk Classification

`classifyToolRisk(toolName, toolRiskOverlay)` maps tool names to risk tiers:

| Tier       | Meaning                                           |
| ---------- | ------------------------------------------------- |
| `safe`     | No approval needed                                |
| `caution`  | Needs approval unless bypassed                    |
| `critical` | Needs approval unless bypassed at critical level  |
| `never`    | Always requires approval, cannot be auto-approved |

### Approval Gate

`requiresHumanApproval(tier, bypassUpTo)` returns true when the tool's risk tier is strictly above the session's effective bypass level.

### Pending Actions

When approval is required, the tool loop:

1. Enqueues a `PendingActionRow` with tool name, args, risk tier, and expiry.
2. Notifies the operator (e.g. Discord reaction prompt).
3. Waits for resolution via `HitlResolutionHub` (in-memory waiters notified on approve/deny/timeout).
4. On approval: proceeds with execution. On denial: injects error back to model.

### Auto-Approve

`HitlAutoApproveGate` allows operators to grant blanket approval for specific tools per session (e.g. via ✅ reaction). The `never` tier cannot be auto-approved.

---

## Elevation

Elevation grants temporary privileged execution to a session.

### Elevation Store

`createElevationStore(db)` manages `elevation_grants` rows:

- `grant(sessionId, durationMs)` — creates a time-limited grant (default 5 min, max 30 min).
- `revoke(grantId)` / `revokeAllForSession(sessionId)` — immediately revoke.
- `isActive(sessionId)` — true if any non-revoked, non-expired grant exists.
- `getStatus(sessionId)` — returns active grant details and remaining time.

### Elevated Execution

`handleElevate(args, ctx)` runs a command via `execFileSync` only if an active elevation grant exists. Commands run with a 30s default timeout (max 120s) and 256 KB output cap.

---

## Timers

`TimerScheduler` provides deferred message delivery:

- `schedule(db, timer)` — inserts a timer row and adds to an in-memory min-heap. Reschedules the next `setTimeout`.
- `cancel(db, id)` — marks fired in DB, removes from heap.
- `cancelByAnchorSession(sessionId)` — cancels all unfired timers anchored to a session; idempotent, returns count canceled.
- `restore(db)` — on startup, fires all past-due timers immediately and schedules the rest.
- `shutdown()` — clears the pending timeout.

When a timer fires, it delivers a user-turn message to the target session via `runSessionModelTurn`. Timers are persisted in the `timers` table and survive daemon restarts.

---

## Events & Cron

### Event Queue

`events` table implements a durable, at-least-once event queue:

- `emitEvent()` — inserts a pending event with optional idempotency key.
- `claimPendingEvents()` — atomically claims up to N pending events (FIFO).
- `markEventCompleted()` / `markEventFailed()` — transitions events. Failed events retry with exponential backoff (2^n seconds, capped at 1 hour). After `maxAttempts` (default 8), events move to `dead` status.
- `reconcileStaleProcessing()` — requeues events stuck in `processing` with stale claims (restart safety).

### Cron Scheduler

`cron_jobs` table stores recurring jobs with `every:Ns` schedule expressions.

`runCronTick(db)` fires on a configurable interval:

1. Selects enabled jobs where `next_run_at <= now`.
2. Emits a `cron.fire` event for each.
3. Updates `last_run_at` and computes `next_run_at`.
4. Catch-up: fires once even if multiple periods were missed.

### Boot Reconciliation

`runBootReconciliation(db)` runs at startup to:

- Requeue stale `processing` events (from a previous crash).
- Mark orphaned `running` tool runs as failed with reason `restart_reconciliation`.

---

## Turn Queue

`TieredTurnQueue` serializes model turns per session with two priority tiers:

- **system** (high) — internal turns (timer fires, workflow notifications, cron).
- **user** (normal) — operator/user-initiated messages.

Features:

- Per-session serialization: only one turn runs at a time per session.
- Anti-starvation: after N consecutive system turns (configurable `starvationThreshold`, default 2), a user turn is promoted.
- Max queue depth (default 6 per tier). Excess enqueues are rejected with `TurnQueueFullError`.
- `removeById`, `removeByRange`, `removeByCount`, `clear` for queue management.

---

## Retention

`runRetentionJobs()` applies configured retention rules on a periodic interval (default 1 hour when rules exist):

| Rule                              | Effect                                                |
| --------------------------------- | ----------------------------------------------------- |
| `inboundMediaMaxAgeDays`          | Deletes media files older than N days                 |
| `inboundMediaMaxTotalBytes`       | Evicts oldest files when total exceeds limit          |
| `transcriptMessageMaxAgeDays`     | Deletes transcript rows older than N days             |
| `transcriptMaxMessagesPerSession` | Keeps only the N most recent messages per session     |
| `kvMaxEntries`                    | Keeps only the N most recent KV entries per workspace |

All operations are audited. File deletion uses symlink-escape protection.

---

## Workflow Engine

The workflow singleton (`initWorkflow()`) provides parallel/sequential task orchestration:

- `WorkflowServer` — manages workflow state, spawns subagent sessions for tasks, polls for completion, handles retries (see [Workflow](workflow.md)).
- `ControlPlane` — pause/resume/abort/status operations (see [Workflow — Control Plane](workflow.md#control-plane)).
- `StatusManager` — posts and updates status messages on the messaging surface (see [Workflow — Status Messages](workflow.md#status-messages)).

Workflows are persisted to disk (`workflow-state/` directory) and resumed on daemon restart. The `builtin-workflow` tool exposes workflow operations to agents.

Task types: `agent` (subagent session), `tool` (direct tool call), `gate` (conditional), `transform` (template), `message` (post to channel).

---

## Configuration

### Layered Config

Config is loaded from the config directory as layered JSON files. The `configRef` holds the current merged config.

### Hot-Reload

`startConfigHotReload()` watches the config directory with `fs.watch`:

- On change, reloads layered config.
- Compares restart-required keys. If any differ, logs a warning and skips.
- Otherwise, live-applies `policy` and `hitl` slices.
- Debounced at 400ms.

Disable with `SHOGGOTH_CONFIG_HOT_RELOAD=0` or `runtime.configHotReload: false`.

### Dynamic Config

`config_request` control op writes fragments to the dynamic config directory (must be under the config directory). Fragments are merged or overwritten per top-level key.

---

## Health

`HealthRegistry` aggregates dependency probes:

| Probe        | What it checks                             |
| ------------ | ------------------------------------------ |
| `sqlite`     | State DB file/directory accessibility      |
| `discord`    | Discord bot token validity                 |
| `model`      | Model API endpoint reachability (HEAD/GET) |
| `embeddings` | Embeddings API endpoint reachability       |

`snapshot()` returns `{ ok, live, ready, checks, at }`. Probes with `skipped` status don't affect readiness. The daemon retries the model probe up to 4 times at startup with 3s delays.

After a successful model health check, the daemon fetches model metadata (context window sizes) from Gemini and OpenAI-compatible providers.

---

## Shutdown

`ShutdownCoordinator` manages graceful shutdown:

1. `requestShutdown(signal)` — triggered by SIGTERM/SIGINT.
2. Calls `onStopAccepting()` to stop new work.
3. Runs registered drains in order (config-hot-reload, event loops, timer-scheduler, procman, workflow, platforms, control-plane, acpx-processes).
4. Each drain has a deadline from `drainTimeoutMs`.
5. After drains, calls `markInterruptedRunsFailed()` to fail in-flight tool runs.
6. Closes the state database.
7. Resolves the `finished` promise, triggering `process.exit(0)`.

### Drain Registration Order

Drains execute in registration order. Key drains:

1. `config-hot-reload` — stop file watcher
2. `stop-event-loops` — clear heartbeat, cron, retention intervals
3. `discord-messaging` — disconnect Discord gateway
4. `timer-scheduler` — clear pending timeouts
5. `procman` — stop all managed processes
6. `workflow` — stop all running workflows
7. `platforms` — stop platform adapters, clear subagent runtime
8. `control-plane` — close Unix socket
9. `acpx-processes` — kill ACPX child processes

---

## Agent Turns

`executeSessionAgentTurn()` is the main entry point for running a model turn:

1. Drains buffered system context and prepends a UTC timestamp.
2. Strips falsified system context from user input (anti-spoofing).
3. Wraps with trusted system context if provided.
4. Evaluates tool discovery triggers.
5. Appends user message to transcript.
6. Loads transcript history and builds the model message array.
7. Resolves MCP tool context (builtin + external tools — see [MCP Integration](mcp-integration.md)).
8. Creates a [failover tool-calling client](models.md#failover-chain) from the models config.
9. Runs the tool loop.
10. Extracts the latest assistant text and any `show` attachments.
11. Records token usage and turn count in session stats.

Error handling: `TurnAbortedError` returns partial results. Other errors are caught and surfaced as error text (unless `throwOnError` is set for workflow tasks).

---

## Platform Integration

The daemon currently supports Discord as a messaging platform:

- **Inbound**: Discord messages route to sessions via configured channel→session mappings.
- **Outbound**: Assistant replies are posted/streamed to Discord channels.
- **Reactions**: Used for HITL approval (✅/❌), choice prompts, and operator passthrough.
- **Threads**: Subagent sessions can bind to Discord threads.
- **Slash commands**: Routed through `createDiscordInteractionHandler`.

Platform registration is modular via `registerPlatform()` / `stopAllPlatforms()`.

---

## Subagents

Subagent sessions are child sessions spawned from a parent:

- URN format: `agent:<agentId>:<platform>:channel:<parentLeafUuid>:<newUuid>`
- Inherit parent's workspace and working directory.
- Modes: `one_shot` (terminates after one turn) or `persistent` (lives until TTL or explicit kill).
- `reconcilePersistentSubagents()` runs at startup to restore or expire persistent subagents.

The `subagentRuntimeExtensionRef` provides `runSessionModelTurn` and `subscribeSubagentSession` to the rest of the daemon.

---

## Audit

`appendAuditRow()` writes to the `audit_log` table with fields: source, principal kind/id, session/agent id, peer uid/gid/pid, correlation id, action, resource, outcome, and redacted args JSON.

All control plane operations, retention jobs, and policy decisions are audited.

---

## Key Environment Variables

| Variable                            | Purpose                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `SHOGGOTH_CONFIG_DIR`               | Override config directory                                                     |
| `DISCORD_BOT_TOKEN`                 | Bot token when `discord.tokenEnv` is unset (overrides inline `discord.token`) |
| `SHOGGOTH_CONFIG_HOT_RELOAD`        | Set to `0` to disable                                                         |
| `SHOGGOTH_SESSION_SYSTEM_PROMPT`    | Appended to system prompt                                                     |
| `SHOGGOTH_GLOBAL_INSTRUCTIONS_PATH` | Override operator instructions path                                           |
| `SHOGGOTH_RETENTION_MS`             | Override retention interval (0 disables)                                      |
| `SHOGGOTH_MODEL`                    | Fallback model name                                                           |
| `ANTHROPIC_BASE_URL`                | Anthropic API base URL                                                        |

---

## See Also

- [Models](models.md) — provider abstraction, failover, compaction, resilience
- [Shared](shared.md) — config schema, session URNs, context levels, policy types
- [Workflow](workflow.md) — task graph orchestration engine
- [MCP Integration](mcp-integration.md) — tool catalog aggregation and external MCP servers
- [Platform Discord](platform-discord.md) — Discord gateway, messaging, HITL reactions
- [Skills & Plugins](skills-plugins.md) — skill discovery and plugin hooks
- [CLI](cli.md) — operator command-line interface
