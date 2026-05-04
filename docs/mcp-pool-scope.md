# MCP Pool Scopes

Shoggoth supports three MCP connection pool scopes that control how MCP server connections are shared across sessions and agents. Each scope trades isolation for resource efficiency.

---

## Pool Scopes

### `global`

A single MCP connection pool is shared across all sessions and agents. This is the default.

- Most resource-efficient: one connection set regardless of session count.
- All sessions see the same MCP server state.
- Suitable when MCP servers are stateless or state sharing is acceptable.

### `per_agent`

One MCP connection pool per logical agent ID. Sessions belonging to the same agent share a pool, but different agents get separate pools.

- Provides agent-level isolation without per-session overhead.
- Agent identity (uid, gid, workspace path) is resolved from existing session rows for that agent.
- Pools are created lazily on first `resolveContext` for a session belonging to that agent.

### `per_session`

Each Shoggoth session gets its own MCP connection pool, created lazily on first inbound turn.

- Maximum isolation: no state sharing between sessions.
- Highest resource cost: one connection set per active session.
- Pools are closed when the session's orchestrator stops or when idle eviction fires.

---

## Configuration

### Top-level default

Set the default pool scope for all MCP servers in the `mcp` config block:

```jsonc
{
  "mcp": {
    "servers": [{ "id": "my-server", "transport": "stdio", "command": "my-mcp" }],
    "poolScope": "per_agent",
  },
}
```

Valid values: `"global"` (default), `"per_agent"`, `"per_session"`.

### Per-server override

Individual servers can override the top-level default using the `poolScope` field:

```jsonc
{
  "mcp": {
    "servers": [
      {
        "id": "shared-db",
        "transport": "tcp",
        "host": "localhost",
        "port": 3000,
        "poolScope": "global",
      },
      {
        "id": "agent-tools",
        "transport": "stdio",
        "command": "agent-mcp",
        "poolScope": "per_agent",
      },
      {
        "id": "session-state",
        "transport": "stdio",
        "command": "state-mcp",
        "poolScope": "per_session",
      },
    ],
    "poolScope": "global",
  },
}
```

Per-server `poolScope` values:

| Value           | Behavior                                                     |
| --------------- | ------------------------------------------------------------ |
| `"inherit"`     | Use the top-level `mcp.poolScope` (default when omitted).    |
| `"global"`      | Always use the global pool, regardless of top-level setting. |
| `"per_agent"`   | Always use a per-agent pool for this server.                 |
| `"per_session"` | Always use a per-session pool for this server.               |

When servers have mixed scopes, the runtime partitions them into three groups (global, per-agent, per-session) and manages separate connection pools for each group. A session's `resolveContext` merges tools from all applicable pools into a single unified tool catalog.

---

## Agent Identity

Per-agent pools run MCP server processes under the agent's identity:

- **uid/gid**: Resolved from an existing session row for that agent. Falls back to 900/900 if no session exists yet.
- **workspacePath**: `{workspacesRoot}/{agentId}`.

This ensures agent-scoped MCP servers operate within the correct filesystem sandbox.

---

## Idle Eviction

All pool scopes share a unified idle eviction mechanism controlled by `perInstanceIdleTimeoutMs`.

### How it works

1. When a model turn ends (`notifyTurnEnd`), an idle timer is scheduled for each active pool scope (global, per-agent, per-session).
2. When a new turn begins (`notifyTurnBegin`), pending idle timers for all applicable scopes are cancelled.
3. If no turn begins before the timeout expires, the pool is evicted (connections closed).
4. On the next `resolveContext`, evicted pools are lazily reconnected.

### Configuration

```jsonc
{
  "mcp": {
    "servers": [
      /* ... */
    ],
    "perInstanceIdleTimeoutMs": 1800000,
  },
}
```

| Value   | Behavior                                                                                      |
| ------- | --------------------------------------------------------------------------------------------- |
| Omitted | Defaults to `SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS` (1,800,000 ms = 30 minutes).              |
| `0`     | Disables idle eviction. Pools stay connected until explicit shutdown.                         |
| `> 0`   | Evict pool instances after this many milliseconds of inactivity (no turn begin/end activity). |

### Scope interaction

- **Global pool**: A single idle timer. Any session's `notifyTurnBegin` cancels it; the last session's `notifyTurnEnd` restarts it.
- **Per-agent pool**: One timer per agent ID. Any session belonging to that agent cancels/restarts the timer.
- **Per-session pool**: One timer per session ID. Only that session's turns affect the timer.

### Shutdown

`shutdown()` clears all idle timers across all scopes before closing pools, preventing stale timer callbacks from firing after cleanup.

---

## See Also

- [Shared Package Reference](shared.md) — schema definitions for `ShoggothMcpConfig`, `ShoggothMcpServerPoolScope`
- [MCP Integration](mcp-integration.md) — runtime MCP server connection details
