# Implementation plan

## Phase 1 — transport exit tap (mcp-integration)

Files: `packages/mcp-integration/src/mcp-jsonrpc-transport.ts`,
`packages/mcp-integration/test/mcp-stdio-procman-exit.test.ts` (new).

1. RED: new test file — procman path, kill the child, assert `onServerExit`
   fires once with exit details and `request()` rejects.
2. GREEN: add `onExit` option to `createMcpJsonRpcSession` (fired on
   stream end/error, once), `onServerExit` on `McpStdioConnectOptions`, wire in
   `connectMcpStdioSessionViaProcman`.

## Phase 2 — pool respawn (daemon/mcp)

Files: `packages/daemon/src/mcp/mcp-server-pool.ts`,
`packages/daemon/test/mcp/mcp-server-pool-server-exit.test.ts` (new).

1. RED: connect a pool to the mock stdio server; kill the managed child
   (looked up via `getProcessManager()`); assert `pool.onServerExit` fires and
   a subsequent `external()` call succeeds (respawned session), catalog
   refreshed.
2. GREEN: implement `handleServerExit` (session swap + respawn + coalescing),
   add `McpServerPool.onServerExit`/`isServerLive`/`hasLiveServers`, add
   `McpServerConnectStatus.transport`.

## Phase 3 — runtime liveness (daemon/sessions)

Files: `packages/daemon/src/sessions/session-mcp-runtime.ts`,
`packages/daemon/test/sessions/session-mcp-runtime-restart.test.ts` (new).

1. RED: fake `connectShoggothMcpServers` returning a pool whose
   `hasLiveServers()` flips false; assert second resolveContext triggers a
   fresh connect for per-agent / global / per-session scopes, and dependent
   per-session entries for the agent are dropped.
2. GREEN: cache descriptors with `live()`; eviction + reconnect on dead hit.

## Phase 4 — verify + ship

1. `npx vitest run packages/daemon/test/mcp packages/daemon/test/sessions/session-mcp-*`
   targeted, then full `npm test`.
2. `npx tsc --noEmit` (hooks run this on push too).
3. Commit per phase, push, open PR to `main` referencing issue #734.

## Addendum (post-implementation)

- The planned `McpServerConnectStatus.transport` field was dropped: it broke an
  existing `deepEqual` in `mcp-server-pool.test.ts` and had no consumer after
  the transport-wrapping approach was simplified away.
- Death detection rides entirely on the `onServerExit` connect option (procman
  stdio path); the transport's `onExit` tap remains available but the pool does
  not wrap sessions.
- Crash-loop guard: rapid re-deaths (within 10 s of a successful respawn)
  increment a per-server streak; at 3 the pool stops auto-respawning until the
  next explicit connect. Backoff (250 ms × 2^streak, cap 8 s) spaces attempts.
- MCP stdio procman spec now uses `restart: { mode: "never" }`: the pool owns
  recovery; a procman-restarted child cannot be bridged to the dead session
  object and would race the pool's respawn.
