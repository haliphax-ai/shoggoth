---
date: 2026-05-04
completed: never
---

# Per-Agent MCP Pool Scope

## Summary

Add a `per_agent` pool scope for MCP servers so that a single global server definition can produce one isolated MCP connection/process per logical agent ID, shared across all of that agent's sessions. Additionally, make both `per_agent` and `per_session` scoped MCP servers run under the agent's UID/GID with the agent's workspace as `$HOME`, using the existing `runAsUser` infrastructure.

## Motivation

Today `poolScope` offers two extremes:

- `global` — one shared MCP instance for all agents and sessions. No isolation.
- `per_session` — one MCP instance per Shoggoth session ID. Maximum isolation, but potentially many processes for a single agent (main session + subagents each get their own).

Neither provides agent-level isolation. Operators often want a middle ground: configure an MCP server once in the global `mcp.servers` list, but have the platform spin up a separate instance for each agent.

Critically, even `per_session` today runs MCP server processes as the daemon's UID/GID with the daemon's environment. Many MCP servers write state to disk, use `$HOME` for config, or otherwise interact with the filesystem. Without running under the agent's identity, separate processes are just separate PIDs with identical filesystem access — not meaningful isolation.

Both `per_agent` and `per_session` scoped MCP servers should run under the agent's UID/GID with `$HOME` set to the agent's workspace, using the existing `runAsUser`/`spawnAsUser` pattern from `@shoggoth/os-exec`.

## Design

### Pool Scope Hierarchy

```
global          → 1 instance total (daemon identity, shared by all agents/sessions)
per_agent       → 1 instance per logical agent ID (agent identity, shared by that agent's sessions)
per_session     → 1 instance per session ID (agent identity, no sharing)
```

### Agent Identity Execution

The existing infrastructure already has all the pieces:

1. **`runAsUser` / `spawnAsUser`** (`@shoggoth/os-exec/subprocess.ts`) — spawn child processes with POSIX `uid`/`gid` via Node's `posix_spawn`. The daemon runs as root (or privileged); the child drops to the agent user.

2. **Session rows** store `runtimeUid` and `runtimeGid`, set during bootstrap from the system `agent` user (typically UID 900).

3. **`resolveAgentWorkspacePath(wsRoot, agentId)`** — resolves the agent's workspace directory.

The MCP stdio spawn path (`openMcpStdioClient` → `connectMcpStdioSession`) currently uses bare `child_process.spawn()` or procman with no UID/GID. This needs to be extended.

For `per_agent` and `per_session` pools, the MCP server process will be spawned with:

- `uid` / `gid` from the agent's session row (or bootstrap credentials)
- `$HOME` set to the agent's workspace path
- `cwd` defaulting to the agent's workspace path (unless the server config specifies one)
- The server config's `env` merged on top of these agent-specific defaults

`global` scope remains unchanged — daemon identity, no workspace scoping.

### Key Decisions

1. **Agent ID extraction** — The agent ID is already embedded in session URNs (`agent:<agentId>:…`) and extractable via `parseAgentSessionUrn`. The pool key for `per_agent` is simply the agent ID string.

2. **Credential resolution** — For `per_agent` pools, credentials come from any session belonging to that agent (looked up via session store on first connect). For `per_session` pools, credentials come from the specific session row. Both fall back to the bootstrap default (UID 900 / GID 900) if the session row lacks credentials.

3. **Lifecycle** — Per-agent pools are created lazily on first `resolveContext` call from any session belonging to that agent. They persist until daemon shutdown (no idle eviction by default). An optional `perAgentIdleTimeoutMs` config field can enable idle eviction analogous to the existing `perSessionIdleTimeoutMs`.

4. **Subagent inheritance** — Subagent sessions spawned by an agent share the parent agent's pool when the subagent's logical agent ID matches. If a subagent has a different agent ID, it gets its own per-agent pool.

5. **Mixed scopes** — A single `mcp.servers` list can contain servers with different `poolScope` values. The existing `partitionMcpServersByEffectiveScope` function is extended to produce a three-way split: global, per-agent, and per-session servers.

6. **Cancel handler registration** — Per-agent pools register their cancel handler under a synthetic key `__agent__:<agentId>` (distinct from session URNs and the global key).

7. **Idle eviction** — When `perAgentIdleTimeoutMs` is set and > 0, the timer resets on every `notifyTurnEnd` for any session belonging to that agent. Eviction closes the pool; the next `resolveContext` reconnects lazily.

### Data Flow

```
resolveContext(sessionId)
  ├─ parse agentId from sessionId
  ├─ resolve agent credentials (uid/gid) and workspace path
  ├─ global servers → shared global pool (existing, daemon identity)
  ├─ per_agent servers → perAgentPools.get(agentId) ?? lazyConnect(agentId, agentCreds)
  ├─ per_session servers → perSessionPools.get(sessionId) ?? lazyConnect(sessionId, agentCreds)
  └─ merge catalogs from all three tiers → buildMixedSessionMcpToolContext
```

### Spawn Path Changes

```
connectShoggothMcpServers(servers, options)
  └─ for each stdio server:
       if options.agentContext provided:
         spawn with uid/gid, HOME=workspacePath, cwd=workspacePath
       else:
         spawn with daemon identity (existing behavior, used by global scope)
```

## Testing Strategy

- Unit tests for the schema change (new enum value parses correctly).
- Unit tests for `partitionMcpServersByEffectiveScope` with three-way output.
- Unit tests for `McpStdioConnectOptions` accepting and passing through `uid`/`gid`/`env` overrides.
- Integration test for `createSessionMcpRuntime` verifying:
  - Two sessions with the same agent ID share one per-agent pool.
  - Two sessions with different agent IDs get separate per-agent pools.
  - Per-agent and per-session pools receive agent credentials in their connect options.
  - Idle eviction fires and reconnect works.
- Existing `per_session` and `global` tests continue to pass unchanged.

## Considerations

- Per-agent pools are not evicted by default (unlike per-session). This is intentional — agents are long-lived and the number of agents is typically small. Operators who want eviction can set `perAgentIdleTimeoutMs`.
- The `per_agent` scope is most useful for stdio MCP servers where each process has its own state. For HTTP MCP servers, the server itself may already handle multi-tenancy, making `global` sufficient. UID/GID is only relevant for stdio (and potentially TCP if the server is spawned locally).
- If an agent ID cannot be parsed from a session URN (e.g. legacy or malformed URNs), the system falls back to the global pool for that session's per-agent servers.
- The `global` scope intentionally does NOT run as any agent's identity — it runs as the daemon. This is correct because global pools are shared across agents and should not be scoped to any single agent's filesystem.
- The existing `per_session` scope will gain agent-identity execution as part of this work. This is a behavioral change for existing `per_session` users, but it's the correct behavior — a per-session MCP server should run in the context of the agent that owns that session.

## Migration

No data migration required. The new `per_agent` enum value is additive. Existing configs with `global` continue to work unchanged.

**Behavioral change for `per_session`:** existing `per_session` MCP servers will now run under the agent's UID/GID instead of the daemon's. This is a security improvement but could break setups where the MCP server command requires daemon-level privileges. Operators in that situation should switch those servers to `global` scope.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
