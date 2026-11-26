---
date: 2026-11-26
completed: 2026-11-26
---

# Plan: MCP pool recovers from dead/restarted stdio servers

Fixes #734. A running stdio MCP server dying (or being restarted) leaves the
MCP pool serving a permanently dead in-memory session. Recovery only happened
via the ~30-minute idle-eviction sweep. This plan makes the pool detect the
death, invalidate caches, and reconnect immediately.

## Motivation

- `connectMcpStdioSessionViaProcman`'s `managed.on("exit")` handler only ends
  the stdout bridge stream; the pool's `sessions` map and the runtime's
  per-agent cache are never notified.
- The tool-loop's mid-turn "reconnect and retry once" path is a cache hit on
  the stale entry (`ensurePerAgentPool` returns the same dead session), so the
  retry re-throws instantly.
- procman's own restarts are silent to the daemon log (`ProcessManager` only
  forwards `state-change` as `process-started/stopped/failed` on its own
  EventEmitter; MCP pool never listens).

## Design

### Layer 1 — transport (packages/mcp-integration)

- `createMcpJsonRpcSession` accepts `onExit(err?)`: invoked exactly once when
  the session becomes unusable without a deliberate `close()` — input `end`,
  input `error`, or (procman path) the managed process's exit event. Errors
  from the tap are swallowed.
- `connectMcpStdioSessionViaProcman` gains `onServerExit(code?, signal?)` in
  `McpStdioConnectOptions`; the `managed.on("exit")` handler ends the stdout
  bridge (unchanged) and calls it (new).

### Layer 2 — pool (packages/daemon/src/mcp/mcp-server-pool.ts)

- `McpServerPool` gains `readonly onServerExit?: (sourceId, info) => void` and
  `readonly setServerSession?: (sourceId, session) => void`.
- `McpServerConnectStatus` gains `readonly transport?: "stdio" | "tcp" | "http"`.
- When a stdio session reports exit via the transport's `onExit` tap (wired
  from `managed.on("exit")`), the pool: logs `mcp.pool.server_exited`,
  replaces the dead session with a fresh handshake (spawn → initialize →
  tools/list) with retry/backoff/circuit breaker; on success swaps the session
  into `sessions` (routing is via the map, so all cached `external` closures
  route to the new session) and refreshes the catalog in place;
  `mcp.pool.server_respawn_ok` / `mcp.pool.server_respawn_failed`. Concurrent
  respawn attempts coalesce. A close of the pool closes the in-flight respawn
  coalescer too.
- If the initial session was never registered (e.g. connect threw), the exit
  tap still fires with `null` session; the pool ignores it (nothing to
  replace).

### Layer 3 — runtime (packages/daemon/src/sessions/session-mcp-runtime.ts)

- `ensurePerAgentPool` caches a descriptor `{ servers, sources, external, live }`
  where `live()` returns false when any stdio session in that pool is dead
  (close/exit observed at the transport). On cache hit with `live() === false`:
  drop the cache entry, tear down the stale pool, log
  `session.mcp_pool.server_exited` + `session.mcp_pool.per_agent_reconnect`,
  and reconnect from scratch with `rearmCircuits: true` (explicit recovery,
  not churn).
- The same applies to the global pool (`live()` false → full reconnect on next
  resolveContext, re-arm circuits) and per-session pools (`live()` false →
  drop per-session cache entry + close fn, force reconnect on next
  resolveContext).
- Liveness is implemented via an exit tap on the pool: the pool object exposes
  `onServerExit` (invoked by the pool impl) plus `isServerLive(sourceId)` and
  a `hasLiveServer()` helper used by the runtime.

### Failure semantics

- Mid-turn call to a server that dies mid-call: transport request rejects
  (stream end) → `mcp_tools_call_failed` → tool-loop retries once after
  `reconnectExternal` → resolveContext → stale cache detected dead → fresh
  connect → retry succeeds. No more permanent brick.
- Pool close during in-flight respawn: coalescer respects an aborted flag; its
  `close` is called by pool.close.

## Files touched

- `packages/mcp-integration/src/mcp-jsonrpc-transport.ts` — `onExit` tap +
  `onServerExit` option on the procman path.
- `packages/daemon/src/mcp/mcp-server-pool.ts` — exit tap → session swap +
  catalog refresh; `McpServerPool` gains `onServerExit`/`setServerSession` and
  `isServerLive`/`hasLiveServer`; `McpServerConnectStatus.transport`.
- `packages/daemon/src/sessions/session-mcp-runtime.ts` — liveness checks in
  ensurePerAgentPool/global/per-session cache reads; reconnect on death.
- Tests (TDD, red → green):
  - `packages/mcp-integration/test/mcp-stdio-procman-exit.test.ts` (new)
  - `packages/daemon/test/mcp/mcp-server-pool-server-exit.test.ts` (new)
  - `packages/daemon/test/sessions/session-mcp-runtime-restart.test.ts` (new)

## Testing strategy

- Layer 1: fake a managed process that exits after N ms; assert `onServerExit`
  fires and pending requests reject fast (already true — stream end) — the new
  assertion is that the tap fires once.
- Layer 2: real `connectShoggothCpmServers` with the mock stdio server fixture;
  kill the child (`managedProcess.kill()`); assert the pool replaces the
  session (next `tools/call` succeeds) and logs/returns respawn status.
- Layer 3: `createSessionMcpRuntime` with a fake `connectShoggothMcpServers`
  plus a fake "death" trigger; assert the second `resolveContext` reconnects
  (second connect call) and per-agent/per-session/global caches are dropped.
- Full: `npm test` + `npx tsc --noEmit`.

## Considerations

- The respawn must NOT be routed through the tool-loop's retry; it's a pool
  concern. The tool-loop's single retry keeps working as the last-resort for
  races (death mid-call).
- Circuits: the respawn uses the same retry budget/circuit breaker, but an
  explicit server-exit respawn re-arms that server's circuit (recovery, not
  churn).
- The runtime's `live()` must not throw; wrap in try/catch and treat as live
  on error (conservative).
