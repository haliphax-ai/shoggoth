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
| `session_yolo_mode`              | Persistent per-session yolo flag (HITL bypass; no expiry until cleared)                                                                           |
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
- `contextSegmentId` — a UUID scoping which transcript messages the model sees. `new` mints a fresh UUID; `reset` keeps the current one and wipes its transcript.
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
- `kill(sessionId)` — revokes the agent token, sets status to `terminated`, and cascades to every descendant session: their tokens are revoked, their status set to `terminated`, in-flight turns aborted, subagent runtime handles disposed, and anchored timers canceled. Top-level sessions (no parent) are never terminated by the cascade — their durability comes from being bound to a platform channel.
- `rotateAgentToken(sessionId)` — mints a new token for an existing session.
- `attachPromptStack` / `setLightContext` — update session metadata.

### Context Segments

Context segments (`sessions.context_segment_id`) scope transcript messages for model context. Two operations exist:

- **New** (`applySessionContextSegmentNew`) — mints a new segment UUID, so the previous segment's transcript rows are abandoned (excluded from model context by the new segment id) and left for the retention workflow to clean up.
- **Reset** (`applySessionContextSegmentReset`) — does NOT mint a new segment id: it deletes the transcript rows of the current segment in place (not abandoned) and the session continues with the segment id it already had.

Both deny pending HITL actions, clear the re-read-required list (stale line numbers no longer apply to a fresh transcript), reset the session's tool state to the agent's defaults (session tool discovery overlays from the previous transcript do not carry over), regenerate the system-context token, reset segment stats, and kill the session's still-running **one-shot** subagents (via the optional `killSubagents` callback). **Persistent** subagents (`subagentMode === "persistent"`) are never killed by either operation — they outlive the parent's context lifecycle and are torn down only by TTL/inactivity or an explicit subagent kill. Both push a "Fresh session" system context message.

**New** additionally clears **per-session** tool auto-approve (`hitl_session_tool_auto_approve`, e.g. ✅ "this tool for session"). **Reset** retains per-session auto-approvals.

### Steer Channel

`sessions/steer-channel.ts` implements per-session injection of operator guidance into an active tool loop (same singleton-map pattern as `system-context-buffer.ts`). The tool loop drains the queue between tool-call batches and injects the messages into the model context.

Delivery and answeredness are handshake-based:

- **Drop handshake** — a steer entry may carry an `onDropped` callback; it fires (best-effort, never breaks teardown) when the message is never drained: the turn ended without injecting, or the channel was replaced by a newer turn (a replaced turn's undrained queue is dropped). A warn log accompanies every drop so it is observable; the callback remains the guaranteed-delivery mechanism.
- **Answered handshake** — drained messages move to a per-session injected-but-unanswered set; the receiving turn must settle normally (a model response follows) for `settleSteersAnswered` to clear them. `steerDepth` counts queued (never injected) plus unanswered entries; one-shot teardown treats a non-zero depth as "a directive may still lose its answer" and re-delivers before terminating (`startSteerRedelivery`).
- The unanswered set is keyed by session on purpose: the channel dies with the turn that received the injection, while the "was the directive answered?" question outlives it.

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

Argument validation is universal: unknown arguments (not declared in the tool's schema) and missing required arguments are rejected with an `invalid_arguments` error instead of being silently dropped. The tool loop validates at Stage 2, and the MCP routing executor (`createMcpRoutingToolExecutor`) validates again before dispatching — covering the paths that bypass the loop (workflow tool tasks and the subagent runtime executor). Schemas that declare no `properties` (open schemas) or set `additionalProperties: true` pass args through unchanged.

The MCP routing executor retries an external tool call exactly once when it fails with a closed-session signature (`Error: MCP session is closed` / `MCP session closed`, wrapped by the pool as `{ error: "mcp_tools_call_failed", ... }`). This happens when a pooled MCP session was closed out from under an in-flight turn — typically the 30-minute per-instance idle eviction closing the pool while the turn captured its external invoke at turn start. The retry re-resolves the session's MCP context (lazily reconnecting an idle-evicted pool) and re-dispatches; a second closed-session failure is returned as-is (no retry loop).

### Per-Call Dispatch

`processSingleToolCall()` validates, gates, and executes a single tool call, returning a dispatch result so the caller knows whether to `continue` (skip) or proceed. Errors and denials are pushed back to the model via `pushToolMessage` and appended to the transcript inside the function. Its stages:

1. Name / thinking-leak / unknown-tool validation
2. Args validation
3. Policy check
4. System gates + HITL approval gate
   4.5. `beforeExecute` hook — fired at the proceed-decision point, BEFORE execution, so the runaway breaker can record the call and trip (steer/cancel) while preventing a tripping call from ever running
5. Execution with timeout
6. Result feedback to model + transcript

`beforeExecute` returns `{ kind: "prevented", runawayVerdict }` when the runaway breaker trips on this call: the call is answered with a synthetic tool result (written by the hook), never reaches the executor, and the caller discards the rest of the batch. Otherwise it returns `{ kind: "ok" }` and execution proceeds normally.

### Circuit Breakers

The model loop is `for (;;)` and only exits on abort, a terminal no-tool-call response, or the structured-output retry budget. Three backstops terminate a stuck turn cleanly (same `break` style as the retry-exhausted path):

- **Consecutive invalid tool calls** (`MAX_CONSECUTIVE_INVALID_TOOL_CALLS`) — unknown tool name, unparseable arguments, or schema-invalid arguments on a known tool are all calls the model could retry forever without the loop ever advancing; this many in a row without a valid call in between ends the turn. Near-miss structured-output calls are excluded: they have their own bounded retry budget.
- **Structured-output near-miss** — models under stress sometimes emit a garbled variant (e.g. `__structured_output__parameter`) containing the exact synthetic tool name as a substring. Provider adapters match the synthetic tool with an exact-name check, so these near-misses fall through to the generic unknown-tool path, which has no counter and would spin unbounded; routing them into the structured-output retry budget (`STRUCTURED_OUTPUT_MAX_RETRIES`) bounds the spin. Detection is deliberately simple exact-name-substring containment, excluding the exact name itself (which the adapter intercepts).
- **Runaway breaker** — see below.

#### Runaway Breaker

The runaway breaker (`runaway-breaker.ts`) detects deterministic runaway model behavior that burns the token budget until the TTL expires. Two heuristics share one two-stage state:

- **Duplicate tool calls** — the model keeps issuing the same call (same tool name, same truncated arguments). A rolling window of the most recent tool-call signatures (`RUNAWAY_WINDOW_SIZE`) trips when any one signature's count within the window exceeds the configured maximum (`RUNAWAY_MAX_DUPLICATES`). Signatures are `toolName|args` with args truncated at `RUNAWAY_SIGNATURE_ARGS_CHARS` (2000) characters — calls that differ only past that point (e.g. timestamps deep in a JSON blob) count as duplicates — then hashed so each window entry is fixed-size while preserving equality. The original 200-character capture was too small and canceled valid series of tool calls with a large common JSON prefix; 2000 chars is the compromise.
- **Excessive prose** — the model generates long prose without the tool activity needed to make progress (a runaway monologue). Accumulated assistant prose is charged against a per-turn character budget (`RUNAWAY_PROSE_CHAR_LIMIT`); tool-only rounds charge nothing.

Both heuristics use a shared two-stage response mirroring a physical circuit breaker: the first trip returns `steer` — the model receives an injected steering message telling it to change approach, and the window/budget reset so it gets a fresh chance to recover; the second trip returns `cancel` — the turn is terminated cleanly (same `break`-style as the other in-loop circuit breakers) and an operator notice is posted once through the active turn surface's in-turn banner path (silently skipped when no live surface exists). The window and prose budget reset on either trip, so the model is judged on fresh behavior afterwards.

When a trip prevents a call mid-batch, the remaining tool calls in that batch are answered with a synthetic `runaway_breaker_skipped` result so the next hop (steer) or next turn (cancel) never sees an unanswered tool-call id.

### Steer Channel

The steer channel (`steer-channel.ts`) injects operator guidance into active tool loops, using the same singleton-map pattern as the system-context buffer. Pushed messages may carry an `onDropped` callback: guaranteed in-turn delivery needs to know when a queued message will never reach the model — the turn ended (unregister) or a new turn replaced the channel before the message was drained — so the sender can fall back to another delivery path (e.g. an OOB turn) instead of silently losing the message.

Drained messages additionally get an "answered" handshake: injection consumes the entry, but the consumption only counts as delivered when the receiving turn settles normally (the tool loop marks it answered on completion). If the turn aborts or fails first, the message stays tracked as injected-but-unanswered so a teardown can re-deliver it instead of dropping a directive the model never responded to. Failed turns keep the entries (one-shot redelivery handshake); an operator abort withdraws the directive and settles them.

### Truncated Tool-Call Args

A tool call whose arguments were cut off by the provider's output-token limit (`finish_reason: "length"` / `max_tokens`) raises `ToolCallTruncatedError`. This is a distinct failure from "the model emitted malformed JSON": the arguments are an incomplete prefix of a larger JSON object, so the model cannot repair them by retrying the same call. Healing them to `{}` and asking the model to try again poisons the NEXT provider request — the replayed assistant turn carries the truncated `function.arguments` and the upstream rejects the whole request with an opaque 400 — so the turn is failed fast with an actionable message instead. The rest of the batch is answered with synthetic skip results so the transcript stays well-formed, and the truncation is surfaced as the turn's failure: the operator (and the model, on the next turn) sees an explicit error instead of a silent stop that looks like the agent gave up.

### Compaction Gate

Manual compaction requests are deferred into an active tool loop through a per-session gate (`compaction-gate.ts`, the steer-channel pattern: singleton map, one queue per session). Compaction rewrites the session transcript while the model client holds the same messages in memory, so it must only run when the loop is parked at a logical break (top of round, after steering injection, after the loop) and the turn queue is frozen behind the in-flight turn. A compaction request parked in the gate is drained by the loop at the next break; a request that arrives with no active loop gets `undefined` back and the caller falls back to running the compaction as a queued turn instead. When the turn settles, the gate is unregistered and leftover parked requests are rejected with `CompactionGateClosedError` so their callers fall back too.

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

Registered builtins include: exec, fetch, fs operations, ls, cd, read/write, search-replace, kv, memory, message, ask, session management, show, skills, timer, web-search, workflow, config, discover, elevate, and process manager operations.

The `fetch` handler resolves its undici dispatcher per request: without a configured CA bundle a plain default Agent is built once and reused; with one, an Agent trusting the PEM certificate bundle at the configured path is built and cached per resolved path for the process lifetime. When the path changes, the previous agent is left open so in-flight requests using it can finish; its idle sockets close after undici's keep-alive timeout. Malformed bundles fail fast at dispatcher construction with a clear error (same content validation as startup) instead of a cryptic TLS failure mid-request.

---

## Transcript & Compaction

Transcripts are stored in `transcript_messages` scoped by `(session_id, context_segment_id)`. Each row has a monotonic `seq`, role, content, optional `tool_call_id`, and `tool_calls_json`.

`compactSessionTranscript()` triggers when the context window fills:

1. Load transcript for the current segment.
2. Strip image blocks and thinking blocks (avoid sending large payloads to the summarizer).
3. Call [`compactTranscriptIfNeeded()`](models.md#transcript-compaction) from `@shoggoth/models` with the compaction policy.
4. If compacted, replace the transcript rows and record the compaction in session stats.

Compaction uses a separate model call to summarize older messages, preserving recent ones.

### Transcript Assistant-Prose Extraction

Turn delivery paths need the assistant prose produced during a single turn, and the transcript layout makes two shapes of extraction necessary:

- `extractLatestTranscriptAssistantText` keeps only the LAST tool-call-free assistant segment after a given seq — by design, for paths that just want the turn's concluding text.
- `extractTurnTranscriptAssistantProse` concatenates EVERY assistant text segment written after `afterSeq` — i.e. the prose emitted during a single turn — in transcript order, joined by a blank line. Prose that rides along a tool-call round is included (the tool loop writes content and tool calls in one row, so the pre-tools segment would otherwise be lost); pure tool-call rows carry no content and are skipped naturally. It returns undefined when the turn produced no assistant prose (tool-only turns). This preserves every pre-tools and post-tools segment so prose → tools → prose turns can be delivered whole on non-streaming paths.

## Segments are normalized for newline padding and blank segments so composed prose joins with one blank-line separator, matching the display pipeline's round normalization.

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

| Category | Operations                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System   | `ping`, `version`, `health`                                                                                                                                                                                                               |
| Agent    | `agent_ping`                                                                                                                                                                                                                              |
| Session  | `session_list`, `session_inspect`, `session_send`, `session_steer`, `session_abort`, `session_kill`, `session_model`, `session_compact`, `session_context_new`, `session_context_reset`, `session_context_status`, `session_queue_manage` |
| Subagent | `subagent_spawn`, `subagent_wait`, `subagent_result`                                                                                                                                                                                      |
| HITL     | `hitl_pending_list`, `hitl_pending_get`, `hitl_pending_approve`, `hitl_pending_deny`, `hitl_clear`, `hitl_cruise_control`                                                                                                                 |
| Config   | `config_show`, `config_request`                                                                                                                                                                                                           |
| Process  | `procman_list`, `procman_restart`, `procman_stop`                                                                                                                                                                                         |
| ACPX     | `acpx_bind_get`, `acpx_bind_set`, `acpx_bind_delete`, `acpx_bind_list`, `acpx_agent_start`, `acpx_agent_stop`, `acpx_agent_list`                                                                                                          |
| MCP      | `mcp_http_cancel_request`                                                                                                                                                                                                                 |

All operations are audited to the `audit_log` table.

### Op Dispatch Safety

The op registry (`packages/daemon/src/control/op-registry.ts`) is a static map of literal op names to handlers. `req.op` arrives as an arbitrary string from the wire (`parseRequestLine` does not constrain its format); safety relies on exact-string map lookups against literal keys and on `get()` returning `undefined` for anything else — callers then reject with `ERR_UNKNOWN_OP`. Never index, resolve, or interpolate `op` into paths, imports, or command names, including computed keys on this map. The module must also stay a leaf: the policy engine imports it for the derived defined-op set, so it must not pull runtime state or config into its import graph.

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

### Cruise Control

Cruise control is a per-session HITL auto-pilot. When active, every HITL approval request that does **not** pass configured auto-approvals is routed to a tiny decision-model judge (`packages/daemon/src/hitl/cruise-control.ts`, TypeSafe System One via `DecisionService`) instead of the operator:

- **Approve** — the tool call executes immediately (no pending row, no operator notice).
- **Deny** — a `hitl_denied` tool error with `reason: "cruise"` is fed back to the model (same shape as an operator denial).
- **Escalate** — the request falls through to the normal HITL queue (true HITL).

Decision shape:

- No `--escalate` guidance → a `noul` question whose `true`/`false` criteria are the yes/no guidance; a probability ≥ 0.5 approves.
- `--escalate` provided → a `choice` question with `approve`/`deny`/`escalate` routes; the escalation route scoring at or above `agents.cruiseControl.escalateMinScore` (default `0.34`) escalates even when it is not the highest-scoring route (enough doubt).

Judge failures (no model, decision error, timeout, missing answer) always escalate. The judge model is the activation-time `model` option, falling back to `agents.cruiseControl.model`; when neither is configured, a warning is logged and surfaced at activation.

State is in-memory and per-session (activation does not survive a daemon restart). Activation surfaces:

- Control op: `hitl_cruise_control` — `{ session_id, yes, no, escalate?, model? }` activates/changes, `{ session_id }` is a status query, `{ session_id, deactivate: true }` deactivates.
- CLI: `shoggoth cruise` (see [CLI](cli.md#shoggoth-cruise)).
- Discord: `/cruise` (see [Platform — Discord](platform-discord.md)).

While cruise control is active, a 🚗 section appears in the turn status bar after the sequence counter.

When a judge decision lands mid-turn, a blockquote banner is injected in-place into the active turn's output (`> 🚗✅ Cruise control **approved** \`builtin-exec: git status\``) — ✅ approved / ❌ denied / ⬆️ elevated — carrying the tool name plus the extracted command (from `argv`or`command` args, truncated) when one is present. Turns without a live output surface (internal/OOB turns) skip the banner; the decision itself is unaffected.

---

## Elevation

Elevation grants temporary privileged execution to a session.

### Elevation Store

`createElevationStore(db)` manages `elevation_grants` rows:

- `grant(sessionId, durationMs)` — creates a time-limited grant (default 5 min, max 30 min).
- `revoke(grantId)` / `revokeAllForSession(sessionId)` — immediately revoke an active grant; expired grants are inert and are never counted as revoked.
- `list(sessionId?)` — returns active (non-revoked, non-expired) grants, optionally filtered by session.
- `isActive(sessionId)` — true if any non-revoked, non-expired grant exists.
- `getStatus(sessionId)` — returns active grant details and remaining time.

### Elevated Execution

`handleElevate(args, ctx)` runs a command via `execFileSync` only if an active elevation grant exists. Commands run with a 30s default timeout (max 120s) and 256 KB output cap.

---

## Yolo Mode

Yolo mode is a flag stamped on a session that bypasses HITL approval **by auto-approving** — it does **not** elevate. Commands still route normally and execute as the agent.

It differs from [Elevation](#elevation) in three ways:

- **Persistent, not time-boxed.** The flag lives in the `session_yolo_mode` table for the session's lifetime and never expires; only the operator clearing it turns it off.
- **No elevation.** Nothing about execution privileges changes — the session runs every command as the agent, exactly as before.
- **Risk-tier HITL only.** While the flag is on, the session's effective bypass tier is `never`, so every risk tier (including `never`) runs without queueing. Policy hard-denies, policy `requires_review` verdicts, system gates (AGENTS.md / re-read), and elevation behavior are all unaffected.

While yolo mode is enabled, a 😎 section appears in the turn status bar immediately after the sequence counter.

### Yolo Mode Store

`createYoloModeStore(db)` manages `session_yolo_mode` rows:

- `isEnabled(sessionId)` — true while the flag is set.
- `setEnabled(sessionId, enabled)` — upserts the row when enabling, deletes it when disabling.
- `getStatus(sessionId)` — returns the flag plus `updated_at`.

### Control Op

`yolo_mode` (operator-only) with payload `{ action: "on" | "off" | "status", session_id }` returns `{ ok, sessionId, enabled }`.

- CLI: `shoggoth yolo on|off|status <session-id>` (see [CLI](cli.md#shoggoth-yolo)).
- Discord: `/yolo` (see [Platform — Discord](platform-discord.md)).

---

## Timers

`TimerScheduler` provides deferred message delivery:

- `schedule(db, timer)` — inserts a timer row and adds to an in-memory min-heap. Reschedules the next `setTimeout`.
- `cancel(db, id)` — marks fired in DB, removes from heap.
- `cancelByAnchorSession(sessionId)` — cancels all unfired timers anchored to a session; idempotent, returns count canceled.
- `restore(db)` — on startup, fires all past-due timers immediately and schedules the rest.
- `shutdown()` — clears the pending timeout.

When a timer fires, it delivers a user-turn message to the target session via `runSessionModelTurn`. Timers are persisted in the `timers` table and survive daemon restarts.

### Delivery and Cancel Semantics

Delivery is at-most-once (implemented in `timers/timer-scheduler.ts` and `timers/timer-delivery.ts`):

- A timer is marked `fired = 1` in the DB **before** its delivery begins, so a crash mid-delivery drops the message rather than duplicating it.
- A timer whose delivery is currently in flight can **not** be cancelled: `cancel` and `cancelByAnchorSession` skip it (reporting it as not cancelled) and the pending delivery still completes — a cancel arriving during delivery never contradicts a delivery that lands.
- Timers still in the pending buffer (scheduled but not yet flushed by the turn-end hook) and timers waiting in the heap remain freely cancellable.
- Delivery targets the timer's owning session; when the owner is terminated but its `session_anchor` is alive, the delivery retargets to the anchor — otherwise the platform's turn guard would reject the dead owner and the anchored session would silently lose the wake-up (e.g. a one-shot subagent scheduling a parent-anchored check-in loses it at its own teardown). No store bound (tests/embeds) fails open; a missing or terminated anchor leaves the target on the owner.

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

## Turn Output Presentation

In-turn banners and notices (session-send yield notices, exec / session-send delivery traces, steering directives, judge-decision banners) must land inside the active turn's output rather than as separate channel messages.

- **Steer-channel injection** (`sessions/steer-channel.ts`): messages pushed onto a session's steer channel are drained between tool-call batches and injected into the running turn. A `> 🫵 **Steered:** <prompt>` blockquote anchors an operator `/steer` directive in the turn output; steer-channel content that already leads with its own blockquote banner (in-turn events) surfaces verbatim instead of being re-wrapped.
- **In-turn events** (`messaging/in-turn-event.ts`): async completions that arrive mid-turn — background exec notifications, async agent-to-agent replies, inline tool results with truncated args — are delivered into the _current_ turn through the steer channel instead of spawning an out-of-band turn. Banners follow the emoji-lead blockquote pattern shared with OOB turn banners (`> emoji Title: *detail* `id``). Delivery is guaranteed: when no turn is active, or the turn ends before the queued event is drained, the caller's fallback path (typically the OOB turn) delivers instead; exactly one of the two paths ever runs.
- **OOB turn banners** (`messaging/oob-turn-banner.ts`): when a message-surface-bound session handles an out-of-band turn (timer, incoming inter-session message, workflow status notification), the operator gets a blockquoted "processing" banner at turn start, the status bar streamed live into that message while the turn runs, and a terminal banner (plus any `to_operator` content) at completion. Formatting (block quote, italics, monospace ids) is part of the display aesthetic; builders are platform-neutral and unit-tested, and a platform that cannot edit messages falls back to posting the terminal banner as a new message.
- **Queued-message indicator** (`presentation/queued-message-indicator.ts`): when an operator message lands in the turn queue behind an in-flight turn, the platform marks it so the operator knows it was received — a ⏳ reaction on the queued message when reactions are supported, else a ⏳ reply, else a standalone post. The reaction is removed once the queued message is processed or dropped; reply/post fallbacks carry nothing to clear.
- **Active turn surface** (`presentation/active-turn-surface.ts`): the turn runner registers a per-turn banner collector for its session while the turn is live. Notices are captured with an anchor (committed prose segments, tool calls). Live render re-renders the in-flight display from scratch on every push, splicing notices in at their anchors (slot _s_ = after the _s_-th committed prose segment); terminal render applies the same splice to the composed body at delivery, so the live stream and the delivered message place each notice between the prose segments it fired between. Each body renders at most once — the first render of a body is final and later calls return it untouched — so termination can never produce an intermediate ("bottom-smashed") layout. Prose segments may span several markdown blocks (multi-paragraph rounds), so anchors are located paragraph by paragraph; unresolvable anchors fall back to one trailing block at the end of the body — notices are never dropped.
- **Termination shaping** (`presentation/stream-coordinator.ts`): the final delivery body passes through one-shot shaping steps (banner splice, thinking composition, …) against a single in-memory copy — only the very final result is ever yielded, so the platform surface never renders an intermediate layout. The pass is fail-open: any step that throws (or any interruption) rejects without yielding anything, and the caller keeps the already-streamed output as the delivered record.

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

A queued entry covers only the tool loop. Post-turn delivery (posting/streaming the assistant reply to the platform) runs detached from the queue entry, so a hung platform-side delivery edit cannot wedge the session's `running` flag.

Operator recovery: the `session_queue_manage` `release` action force-releases a wedged running entry, and `session_kill` clears the session's queued entries along with its running entry.

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

## Model Resolution

`resolveModel(db, config, opts)` maps a model ref (`providerId/model`) to its full provider + model definition, honoring per-session model overrides and failover. Effective models config comes from the session's override slice when a `sessionId` is given, else the global `models` config. The algorithm:

1. Determine the target ref: explicit ref > first entry of the effective failover chain.
2. Look up the provider by providerId from the ref.
3. Check `provider_failures`: if failed and not stale → skip to failover; if stale → clear the failure record and try.
4. If the provider is down, find its position in the failover chain and walk from the next entry until a non-failed provider is found.
5. If the chain is exhausted, return null and log a warning.
6. Resolve the model definition from the provider's keyed `models` record by name.

A failed provider is marked for a cooldown duration (`getMarkFailedDuration`, provider-specific or global retry budget) before it becomes eligible again. The failover chain may contain `FailoverChainEntry` (string or `{ ref }`) or `ShoggothModelFailoverHop` (`{ providerId, model }`) entries from agent overrides; entries are normalized to refs.

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
Restart-required keys are enumerated by `CONFIG_RESTART_REQUIRED_KEYS` (`packages/daemon/src/config-policy.ts`); hot reload live-applies the `policy` and `hitl` slices only when the merged config stays equal on every one of those keys. Changes to a restart-required key are logged and ignored until restart, and other subtrees (`models`, `mcp`, `skills`, `plugins`, `memory`, `retention`, `logLevel`, …) are not applied live either — adjust those and restart the daemon.

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

### Drain Groups

Drains registered with a `group` number (`DrainGroup` option) are scheduled by dependency level: drains sharing a group run in parallel via `Promise.allSettled`, and groups execute in ascending numeric order — a group-2 drain starts only after every group-1 drain completes (or fails). The shared `drainTimeoutMs` deadline spans all groups: a drain whose turn arrives after the deadline is skipped, and any drain deadline hit stops scheduling further groups.

Drains registered **without** a group each get a unique implicit group and therefore execute sequentially in registration order (backward compatible).

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
- Modes: `one_shot` (terminates after one turn, under an absolute wall-clock TTL) or `persistent` (terminated by an inactivity timeout — window in minutes (`inactivity_minutes`, default `runtime.maxTtlMs`, 1440 / 24h when unset) since the last delivered response, reset by each delivered response — or by explicit kill). The window is capped at `runtime.maxTtlMs`: an absent `inactivity_minutes` defaults to the max TTL and a provided value is clamped to it, so it is never "forever".
- The never-"forever" guarantee covers one-shot spawns too: `ttl_minutes` (positive number of minutes) sets the one-shot wall-clock TTL, clamped to the tiered one-shot ceiling — an absent `ttl_minutes` defaults to that ceiling, a provided value is capped at it. The ceiling defaults to `runtime.maxTtlMs` and can be lowered via `runtime.maxOneShotTtlMs`, which is itself capped by `runtime.maxTtlMs` (so the tier can never exceed the global ceiling). The resolved absolute deadline (`Date.now() + ttlMs`) is persisted in `subagent_expires_at_ms` (instead of `null`) and enforced with an absolute, never-reset deadline: on expiry the child session is terminated and a structured `ERR_SUBAGENT_TTL_EXPIRED` failure is delivered to the spawning session (foreground spawns settle the awaited turn at the deadline rather than hanging past it; background spawns get the failure through the spawn's completion path), so the parent can decide whether to respawn with a larger budget.
- `reconcilePersistentSubagents()` runs at startup to restore or expire persistent subagents.
- Nesting depth is governed by `maxSpawnDepth` (default 1, per-agent override via `agents.list.<id>.maxSpawnDepth`): a top-level session is depth 0 and may spawn while its depth is below the limit; with the default, subagents cannot spawn nested subagents. This is the sole spawn-permission and nesting gate for agent principals, enforced at both the builtin `subagent` tool and the `subagent_spawn` control op (authoritative) by walking `parent_session_id` lineage; the `subagentSpawnAllow` allowlist (which agent ids a sender may spawn _as_) is a separate gate. Thread-bound persistent subagents (platform-thread-attached, user-visible) are governed by `maxSpawnDepth` like all other sessions — pure `parent_session_id` lineage depth, no platform-thread exemptions (they were previously exempt from the nesting ban). This is distinct from the workflow engine's `maxDepth`.

### Persistent subagent inactivity timers

All persistent subagents (thread-bound or threadless, any spawn path) share one arm/reset implementation (`packages/daemon/src/subagent/persistent-subagent-timers.ts`):

- `armPersistentSubagentInactivityTimer` clears any prior timer, persists the computed expiry (`subagentExpiresAtMs`), and schedules termination (`ttl_expired`) at the expiry.
- `touchPersistentSubagentInactivityTimer` re-arms a full window after each delivered assistant response.
- The startup reconcile re-arms the remaining window from the persisted expiry after a restart (via the `expiresAtMs` option).
- Kill paths tear the timer down via the `clearTtl` handle each arming site registers on the session's subagent runtime handles (`disposeSubagentRuntime`).
- One-shot subagents and regular sessions have no armed inactivity timer (touch is a no-op for them).

### Thread subagents (platform threads)

Threads created on a bound platform channel can get an automatic persistent subagent session (`handlePlatformThreadCreate` — platform-agnostic decision core; platforms stay thin: parse the gateway event, resolve channel→session, post the status banner):

- Enabled unless `agents.threadSubagents` is explicitly `false`.
- No-op when the parent channel is unbound, its session is not top-level, or the parent is terminated.
- Idempotent: a thread with an existing session binding (durable row or runtime map) never gets a second session — re-fired gateway events and reconcile-restored threads are no-ops.
- **Control-plane spawn claims** (`thread-subagent-claims.ts`): a platform `THREAD_CREATE` event carries no signal distinguishing a thread the operator's `subagent_spawn` op just created (via REST) from a user-created one — the autocreate routine would race the spawn op and, on losing the binding, leave a banner-only zombie session. The spawn flow therefore claims the thread _before_ it exists: an **explicit thread id** claim (`spawn_persistent` with a concrete `platform_thread_id`), or a **pending creation** claim keyed by the parent channel, refcounted and registered before the REST create call (the `thread_id: "0"` sentinel's id is unknown until the call returns, but the event may be dispatched first). Claims are synchronous, exclusive, and released on every spawn exit path (success, thrown error, bind conflict); tests reset the registry with `clearThreadSpawnClaims`. The autocreate path skips claimed threads with reason `control_plane_claimed`.
- When a spawn's thread binding is refused (a concurrent flow won the race), the freshly autocreated thread subagent is adopted by the spawn op (`findAdoptableThreadSubagentSession` — live, persistent, thread-bound, zero transcript messages, same parent; the spawn op's own child is excluded) so its prompt becomes the first model turn instead of failing the spawn and leaving a banner-only zombie.
- Sessions ignore a lone "." inbound message while the thread has no transcript history yet (`shouldSkipThreadSessionSentinel`), letting the operator set the thread up (e.g. switch the model) before the real prompt.
- The agent id is derived from the thread title (a title-less thread falls back to a readable slug, never the numeric platform id), reserved against configured agents and all live subagent ids. The banner (URN + resolved model, shared with the manual `subagent_spawn` path) is posted to the thread immediately, before any turn.

### One-shot notify drain and final result

End-of-turn teardown for a one-shot is deferred while work may still matter (`settleOneShotAfterTurn` / `one-shot-notify-drain.ts`):

- Terminate immediately when nothing is pending (no live exec-notify handles, no in-flight OOB delivery, idle turn queue).
- Otherwise hold the session until pending exec-notify handles drain, capped by the persisted wall-clock expiry (fallback 60 min when the row carries no valid expiry); a safety timer terminates as a normal end when the TTL elapses.
- Releases are identity-checked: a re-armed hold supersedes a captured terminate callback, and the live handle count is re-read at release time (a wake-up turn may have registered new handles).
- A turn that ended non-normally (`aborted`/`failed`/`canceled`) never answers the steers it received: unanswered steers are re-delivered as one structured OOB turn on the still-active session (`startSteerRedelivery`, one attempt — a failed attempt tears down instead of retrying; the target row is re-checked first so a terminated session never receives the turn), and a normal settle then resumes the teardown.
- The final teardown (every path — direct, deferred release, and safety timer — routes through one terminate closure) delivers the child's latest transcript text to its parent as a structured OOB follow-up turn when it differs from what the spawn path already delivered (`markOneShotResultDelivered` dedupes by exact text; this is the steered follow-up case — steering produces a newer reply), then terminates. The parent therefore always hears one of "result" or (via the terminate notice) "ended" for the post-steer lifetime of the child.

### Contract mode (one-shot subagent spawns)

`subagent_spawn` (and the builtin `subagent` tool's `spawn_one_shot` action) accepts an optional `contract` array — entries of `{ path, action, summary }` (`action`: `create` | `update` | `delete`) — plus an optional `judge` decision model (`provider-id/model-name`). The mode is inactive when `contract` is unset or empty.

- **Call-time gate**: each target's repository is discovered from the target's own directory (upward) and from the spawning session's working directory (downward), so contracts may point at a repository nested below the workspace as well as at one containing it; all targets must land in the same repository (the contract is diffed as one unit against one baseline) — otherwise the spawn fails (`ERR_CONTRACT_NOT_IN_REPO`) before any child session exists, notifying the agent. `judge` requires a non-empty `contract` and must name a configured decision provider/model (`ERR_INVALID_JUDGE`). Persistent spawns reject `contract`.
- **Baseline**: the spawn-time `HEAD` is captured as the diff baseline.
- **Git invocation**: contract git commands run as the configured agent uid/gid (`resolveAgentCreds`), not the daemon's — the checks read and diff the agent-owned working tree. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` are stripped from the environment so the working directory alone decides the repository, and `safe.directory=*` is relaxed for these invocations only (the daemon/agent uid split otherwise trips git's "dubious ownership" guard even when DAC permissions allow reading). When the uid switch is not permitted (no `CAP_SETUID`, e.g. CI runners), the command is retried as the current user instead of failing every check. Downward repo discovery is bounded (`MAX_REPO_PROBES`, 512 probes) and probes only real directories (symlinked trees like `node_modules` are skipped); when no target resolves, the validation error names the base directory and the unwalked target.
- **Post-turn verification** (`packages/daemon/src/subagent/contract.ts`): a target not acted upon with its contractual type breaks the contract (no decision call for it; `create` on a pre-existing path and `update` on an untouched path break; `delete` requires the path to be gone), as does any repository file **outside** the listed targets that changed against the baseline (the contract is exhaustive — tracked, deleted, and untracked changes are all listed from git itself, and an unenumerable change set fails closed). Otherwise each per-file `git diff` against the baseline is judged by the decision model in batches (`agents.contract.batchSize`, default 5); deleted files are never sent to the judge — a per-file `noul` answer below `agents.contract.yesMinimum` (default `0.85`) breaks it. Decision failures fail closed.
- **Response**: the spawn response carries an extra `contract` field: `broken` (boolean) with `reason` naming what broke it, plus `yesMinimum`, `entries`, `judged[]` with per-file `yes`, `violated[]`, `unlisted[]`, `deletedSkipped[]`, `baseline`. `reason` is absent while the contract holds. Background one-shots return `{ active: true, pending: true }` and judge asynchronously after the turn.
- **Prompt**: when a contract is active its entries (absolute paths, with the exhaustiveness rule) are appended to the child's task prompt as a `## Contract` section — spawn prompts carry the task only, never a restatement.
- **Workflows**: agent tasks accept the same `contract`/`judge` fields; the daemon spawn adapter validates the contract at spawn (killing the fresh session and failing the spawn on violation) and verifies after the turn. The verdict rides the completion entry: the poll adapter converts an unfulfilled contract into a **failed** task, so the task's success is determined by the contract rather than merely a clean turn.

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
