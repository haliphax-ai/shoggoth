# Implementation

## Phase 1: Schema & Partition Logic

Extend the pool scope enum and update the partition function to produce a three-way split. This phase is purely additive — existing behavior is unchanged.

- Add `"per_agent"` to `shoggothMcpServerPoolScopeSchema` enum
- Add `"per_agent"` to the top-level `mcp.poolScope` enum
- Add optional `perAgentIdleTimeoutMs` field to `shoggothMcpConfigSchema`
- Update `EffectiveMcpPoolScope` type in `mcp-server-pool.ts`
- Update `partitionMcpServersByEffectiveScope` to return `{ globalServers, perAgentServers, perSessionServers }`
- Update all call sites of `partitionMcpServersByEffectiveScope` to destructure the new field (even if unused initially)
- Add `mcpAgentPoolKey` helper to `mcp-http-cancel-registry.ts`
- Unit tests for schema validation with new enum value
- Unit tests for three-way partition logic

**Files:**

- `packages/shared/src/schema.ts`
- `packages/daemon/src/mcp/mcp-server-pool.ts`
- `packages/daemon/src/mcp/mcp-http-cancel-registry.ts`
- `packages/daemon/test/mcp/mcp-server-pool.test.ts`
- `packages/shared/test/mcp-server-rules.test.ts` (update fixture configs)

## Phase 2: Agent Identity in MCP Stdio Spawn

Thread agent credentials (UID/GID) and workspace path through the MCP stdio connect path. This is a prerequisite for both `per_agent` and `per_session` scoped pools to run under the correct identity.

- Add `uid` and `gid` optional fields to `McpStdioConnectOptions` in `mcp-jsonrpc-transport.ts`
- Update `connectMcpStdioSessionDirect` to pass `uid`/`gid` to `spawn()` and set `detached: true` (mirroring `spawnChild` in `@shoggoth/os-exec`)
- Update `connectMcpStdioSessionViaProcman` to pass `uid`/`gid` through to the `ProcessSpec` (or fall back to direct spawn if procman doesn't support it)
- Define `AgentMcpContext` type (`uid`, `gid`, `workspacePath`) in `mcp-server-pool.ts`
- Add optional `agentContext` field to `ConnectShoggothMcpPoolOptions`
- Update `connectShoggothMcpServers` to:
  - When `agentContext` is provided: set `HOME` to `workspacePath` in env, default `cwd` to `workspacePath`, pass `uid`/`gid` to stdio connect
  - When `agentContext` is absent: existing behavior (daemon identity)
- Unit tests: verify `spawn` receives `uid`/`gid` when `agentContext` is provided, and does not when absent

**Files:**

- `packages/mcp-integration/src/mcp-jsonrpc-transport.ts`
- `packages/daemon/src/mcp/mcp-server-pool.ts`
- `packages/mcp-integration/test/mcp-jsonrpc-transport.test.ts` (new or extend)
- `packages/daemon/test/mcp/mcp-server-pool.test.ts` (extend)

## Phase 3: Per-Agent Pool Lifecycle in SessionMcpRuntime

Wire up lazy per-agent pool creation and shutdown in the session MCP runtime. This is the core behavioral change for the new scope.

- Add `perAgentServers` handling in `createSessionMcpRuntime`
- Add `perAgentMcpCtx`, `perAgentMcpClose`, `perAgentMcpConnect` maps (mirroring per-session pattern)
- Add `resolveAgentMcpContext` helper that looks up session row for `runtimeUid`/`runtimeGid` and resolves workspace path via `resolveAgentWorkspacePath`
- Extract agent ID from session URN via `parseAgentSessionUrn` in `resolveContext`
- On first `resolveContext` for an agent ID with per-agent servers, call `connectShoggothMcpServers` with `agentContext` and cache the result
- Subsequent sessions with the same agent ID reuse the cached pool
- Register cancel handler under `mcpAgentPoolKey(agentId)`
- Extend `buildMixedSessionMcpToolContext` (or introduce a three-tier variant) to merge global + per-agent + per-session sources
- Close all per-agent pools in `shutdown()`
- Fallback: if agent ID cannot be parsed, use global pool for per-agent servers
- Integration tests: two sessions same agent share pool; two agents get separate pools; agent credentials are passed through

**Files:**

- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/src/sessions/session-mcp-tool-context.ts` (if `buildMixedSessionMcpToolContext` signature changes)
- `packages/daemon/test/sessions/session-mcp-per-agent.test.ts` (new)

## Phase 4: Agent Identity for Existing Per-Session Pools

Update the existing `per_session` pool path to also use agent identity. Currently `per_session` pools spawn MCP servers as the daemon — this phase fixes that.

- In `resolveContext`, when connecting per-session servers, pass `agentContext` (resolved from the session's agent ID) to `connectShoggothMcpServers`
- The `resolveAgentMcpContext` helper from Phase 3 is reused here
- Existing per-session idle eviction logic is unchanged
- Integration tests: verify per-session pool connect receives agent credentials

**Files:**

- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/test/sessions/session-mcp-idle-timeout.test.ts` (extend to verify agent context)

## Phase 5: Per-Agent Idle Eviction

Add optional idle eviction for per-agent pools, following the same pattern as per-session idle eviction.

- Read `perAgentIdleTimeoutMs` from config (default: disabled / 0)
- Add `perAgentMcpIdleTimers` map
- On `notifyTurnEnd`, if per-agent idle is enabled, schedule/reset a timer keyed by agent ID
- On `notifyTurnBegin`, cancel any pending per-agent idle timer for that agent
- On timer fire: close the per-agent pool, clear cached context, log eviction
- Next `resolveContext` for that agent triggers a fresh connect
- Expose `trackPerAgentIdle` on `SessionMcpRuntime` interface
- Unit tests with fake timers: eviction fires, begin cancels timer, reconnect after eviction

**Files:**

- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/test/sessions/session-mcp-per-agent.test.ts` (extend)

## Phase 6: Test Fixture & Documentation Updates

Update existing test fixtures that reference the MCP config shape, and add documentation.

- Update all test files that construct `mcp: { servers: [], poolScope: "global" }` to ensure they still compile with the widened type
- Update `packages/platform-discord/test/discord-platform.test.ts` if it references the partition function
- Add a section to project docs describing the three pool scopes and agent identity behavior
- Verify the full test suite passes (`vitest run`)

**Files:**

- `packages/shared/test/effective-agent-for-session.test.ts`
- `packages/shared/test/session-query-policy.test.ts`
- `packages/daemon/test/bootstrap-main-session.test.ts`
- `packages/daemon/test/system-context-adoption.test.ts`
- `packages/daemon/test/sessions/model-resolution.test.ts`
- `packages/daemon/test/control/*.test.ts` (config fixtures)
- `packages/platform-discord/test/discord-platform.test.ts`
- `docs/mcp-pool-scope.md` (new or updated)
