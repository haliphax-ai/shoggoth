# Spec: MCP stale-session recovery

## Type additions

```ts
// mcp-jsonrpc-transport.ts
export interface McpJsonRpcSession {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}

// createMcpJsonRpcSession options gain:
| {
    /**
     * Invoked exactly once when the session becomes unusable without a
     * deliberate close(): input stream `end`, input stream `error`, or
     * (procman path) the managed process exiting. Tap errors are swallowed.
     */
    readonly onExit?: (info: { readonly reason: "stream_end" | "stream_error" | "process_exit" }) => void;
  }

// McpStdioConnectOptions gains:
| {
    /** Invoked when the managed (procman) child process exits (crash/restart/stop). */
    readonly onServerExit?: (info: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }) => void;
  }
```

```ts
// mcp-server-pool.ts
export type McpServerPool = {
  readonly externalSources: readonly McpSourceCatalog[];
  readonly cancelMcpRequest?: (sourceId: string, requestId: number) => boolean;
  /**
   * Test/observer tap: fired when a pooled stdio server's process exits
   * (before respawn bookkeeping completes).
   */
  readonly onServerExit?: (info: {
    sourceId: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  /** True when the given source has a live (not exited) session in this pool. */
  readonly isServerLive?: (sourceId: string) => boolean;
  /** True when every session in this pool is live; empty pools return true. */
  readonly hasLiveServers?: () => boolean;
  readonly close: () => Promise<void>;
};

export type McpServerConnectStatus = {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly attempts?: number;
  readonly circuitOpen?: boolean;
  readonly transport?: "stdio" | "tcp" | "http";
};
```

```ts
// session-mcp-runtime.ts
// Per-agent cache entry becomes a descriptor (shape, not exported type):
type PerAgentPoolCacheEntry = {
  readonly servers: readonly ShoggothMcpServerEntry[];
  readonly sources: readonly McpSourceCatalog[];
  readonly external: ExternalMcpInvoke | undefined;
  /** False once any server in the pool has died (exit observed). */
  readonly live: () => boolean;
};
```

## Behavior

1. Transport: `input.on("end")` / `input.on("error")` invoke `onExit` once
   (guarded by a `exitNotified` flag). The procman bridge calls `onServerExit`
   from `managed.on("exit")` and feeds `onExit` via the session options
   (`reason: "process_exit"`).
2. Pool: `startServer` wires the stdio session's exit tap to an internal
   `handleServerExit(s, session, info)`. If the exited session is the one
   currently registered for `s.id`, the pool logs `mcp.pool.server_exited`,
   re-handshakes (same retry/circuit machinery, re-armed), swaps the session
   into the `sessions` map and refreshes the catalog entry in place
   (`externalSources[idx] = …`, fires `onToolCatalogChange`). Logs
   `mcp.pool.server_respawn_ok` / `mcp.pool.server_respawn_failed`. Concurrent
   respawns per server id coalesce; pool close aborts/awaits them.
3. Runtime: `ensurePerAgentPool` returns descriptor with `live()`. Cache hit +
   `!live()` → evict (close pool, drop caches incl. dependent per-session
   entries), reconnect synchronously in resolveContext with `rearmCircuits`.
   Global pool: `!hasLiveServers()` on the live pool → same eviction +
   reconnect. Per-session: `!hasLiveServers()` → drop entry and reconnect.

## Log events

- `mcp.pool.server_exited` (warn) — sourceId, exitCode, signal
- `mcp.pool.server_respawn_ok` (info) — sourceId, attempts
- `mcp.pool.server_respawn_failed` (warn) — sourceId, err
- `session.mcp_pool.server_exited` (warn) — poolScope, key/agentId
- `session.mcp_pool.per_agent_reconnect` (info) — agentId
