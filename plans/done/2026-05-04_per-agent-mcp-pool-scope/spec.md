# Specification

## Schema Changes

### Pool Scope Enum

The `shoggothMcpServerPoolScopeSchema` enum gains a new value:

```ts
export const shoggothMcpServerPoolScopeSchema = z.enum([
  "inherit",
  "global",
  "per_agent",
  "per_session",
]);

export type ShoggothMcpServerPoolScope = z.infer<typeof shoggothMcpServerPoolScopeSchema>;
```

### Top-Level `mcp.poolScope` Default

The top-level default also accepts `per_agent`:

```ts
poolScope: z.enum(["global", "per_agent", "per_session"]).default("global"),
```

### Idle Timeout Config (renamed + unified)

The existing `perSessionIdleTimeoutMs` is replaced by `perInstanceIdleTimeoutMs`. It applies to all pool scopes uniformly:

```ts
/**
 * After the last turn completes for a pool instance (global, per-agent, or per-session),
 * close that pool if no further turn completes within this many milliseconds.
 * `0` disables idle eviction. Default: disabled.
 *
 * - global: timer resets on any session's turn end; evicts the shared pool.
 * - per_agent: timer resets on any turn end from that agent's sessions; evicts that agent's pool.
 * - per_session: timer resets on that session's turn end; evicts that session's pool.
 */
perInstanceIdleTimeoutMs: z.number().int().nonnegative().optional(),
```

The `perSessionIdleTimeoutMs` field is removed from the schema.

### Default Constant (renamed)

```ts
/** Default idle eviction for lazy MCP pools when `perInstanceIdleTimeoutMs` is omitted. */
export const SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS = 30 * 60 * 1000;
```

Replaces `SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS`.

## Interfaces

### McpStdioConnectOptions (updated)

The stdio connect path gains optional agent identity fields:

```ts
export interface McpStdioConnectOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly processManager?: ProcessManager;
  /** When set, the MCP server process is spawned with this POSIX UID (agent identity). */
  readonly uid?: number;
  /** When set, the MCP server process is spawned with this POSIX GID (agent identity). */
  readonly gid?: number;
}
```

### AgentMcpContext

New type passed through the pool connect path to carry agent identity:

```ts
/** Agent identity and workspace context for scoped MCP server processes. */
export interface AgentMcpContext {
  /** POSIX UID for the agent (from session row or bootstrap). */
  readonly uid: number;
  /** POSIX GID for the agent (from session row or bootstrap). */
  readonly gid: number;
  /** Absolute path to the agent's workspace directory. */
  readonly workspacePath: string;
}
```

### ConnectShoggothMcpPoolOptions (updated)

```ts
export type ConnectShoggothMcpPoolOptions = {
  readonly onMcpServerMessage?: (input: {
    sourceId: string;
    msg: McpStreamableHttpServerMessage;
  }) => void;
  /** When provided, stdio MCP servers are spawned under this agent's identity. */
  readonly agentContext?: AgentMcpContext;
};
```

### Partition Function (updated)

```ts
/**
 * Split configured servers by effective pool scope into three buckets.
 */
export function partitionMcpServersByEffectiveScope(
  servers: readonly ShoggothMcpServerEntry[],
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): {
  globalServers: ShoggothMcpServerEntry[];
  perAgentServers: ShoggothMcpServerEntry[];
  perSessionServers: ShoggothMcpServerEntry[];
};
```

### EffectiveMcpPoolScope (updated)

```ts
type EffectiveMcpPoolScope = "global" | "per_agent" | "per_session";
```

### SessionMcpRuntime (updated)

```ts
export interface SessionMcpRuntime {
  readonly resolveContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  readonly notifyTurnBegin: (sessionId: string) => void;
  readonly notifyTurnEnd: (sessionId: string) => void;
  readonly shutdown: () => Promise<void>;
  /** True when perInstanceIdleTimeoutMs > 0 and at least one MCP server is configured. */
  readonly trackInstanceIdle: boolean;
}
```

Replaces the previous `trackPerSessionIdle` and `trackPerAgentIdle` booleans with a single `trackInstanceIdle`.

### Cancel Handler Key Convention

```ts
// Global pool key (existing)
export const SHOGGOTH_GLOBAL_MCP_SESSION_KEY = "__global__";

// Per-agent pool key (new)
export function mcpAgentPoolKey(agentId: string): string {
  return `__agent__:${agentId}`;
}
```

## API / Function Signatures

### connectMcpStdioSessionDirect (updated internals)

When `uid`/`gid` are provided in options, the spawn call changes from:

```ts
// Before (daemon identity)
const proc = spawn(opts.command, [...], {
  cwd: opts.cwd,
  env: opts.env ? { ...process.env, ...opts.env } : undefined,
  stdio: ["pipe", "pipe", "ignore"],
});
```

to:

```ts
// After (agent identity when uid/gid provided)
const proc = spawn(opts.command, [...], {
  cwd: opts.cwd,
  uid: opts.uid,
  gid: opts.gid,
  env: opts.env ? { ...process.env, ...opts.env } : undefined,
  stdio: ["pipe", "pipe", "ignore"],
  detached: true,
});
```

This mirrors the pattern in `spawnChild()` from `@shoggoth/os-exec/subprocess.ts`.

### connectMcpStdioSessionViaProcman (updated internals)

The `ProcessSpec` gains `uid`/`gid` fields (if procman supports them), or the spawn is routed through the direct path when agent identity is required.

### connectShoggothMcpServers (updated internals)

```ts
export async function connectShoggothMcpServers(
  servers: readonly ShoggothMcpServerEntry[],
  options?: ConnectShoggothMcpPoolOptions,
): Promise<{ pool: McpServerPool; external: ExternalMcpInvoke }> {
  // ...
  for (const s of servers) {
    const agentCtx = options?.agentContext;

    // Build env: agent workspace as HOME, then server config env on top
    const baseEnv = agentCtx ? { HOME: agentCtx.workspacePath, ...s.env } : s.env;

    // Resolve cwd: server config cwd, or agent workspace, or undefined
    const cwd = s.cwd ?? agentCtx?.workspacePath;

    const session =
      s.transport === "stdio"
        ? await openMcpStdioClient({
            command: s.command,
            args: s.args,
            cwd,
            env: baseEnv,
            uid: agentCtx?.uid,
            gid: agentCtx?.gid,
            processManager: getProcessManager(),
          })
        : // tcp and http transports unchanged
          // ...
  }
}
```

### resolveContext (internal changes)

```ts
async function resolveContext(sessionId: string): Promise<SessionMcpToolContext> {
  const parsed = parseAgentSessionUrn(sessionId);
  const agentId = parsed?.agentId;

  // Resolve agent credentials for scoped pools
  const agentContext = agentId ? resolveAgentMcpContext(agentId, sessionId) : undefined;

  // 1. Global sources (daemon identity, lazy connect on first resolveContext)
  // 2. Per-agent sources (agent identity, lazy connect keyed by agentId)
  // 3. Per-session sources (agent identity, lazy connect keyed by sessionId)
  // 4. Merge all three tiers into a single context
}
```

### resolveAgentMcpContext (new helper)

```ts
/**
 * Resolve agent credentials and workspace path for scoped MCP pools.
 * Looks up the session row for uid/gid; falls back to bootstrap defaults.
 */
function resolveAgentMcpContext(agentId: string, sessionId: string): AgentMcpContext {
  const session = sessionStore.getById(sessionId);
  const uid = session?.runtimeUid ?? 900;
  const gid = session?.runtimeGid ?? 900;
  const workspacePath = resolveAgentWorkspacePath(config.workspacesRoot, agentId);
  return { uid, gid, workspacePath };
}
```

### Idle Eviction (unified)

```ts
// Unified idle timer maps — one per pool scope, same eviction logic
const globalIdleTimer: { ref?: ReturnType<typeof setTimeout> } = {};
const perAgentIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const perSessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleIdleEviction(key: string, scope: "global" | "per_agent" | "per_session"): void {
  // Cancel existing timer for this key
  cancelIdleEviction(key, scope);
  const timer = setTimeout(() => {
    evictPool(key, scope);
  }, instanceIdleMs);
  // Store in the appropriate map
}

function cancelIdleEviction(key: string, scope: "global" | "per_agent" | "per_session"): void {
  // Clear timer from the appropriate map
}

// notifyTurnEnd schedules eviction for all applicable scopes:
function notifyTurnEnd(sessionId: string): void {
  if (!trackInstanceIdle) return;
  const agentId = parseAgentSessionUrn(sessionId)?.agentId;
  // Schedule for each scope that has active pools
  if (globalPool) scheduleIdleEviction("__global__", "global");
  if (agentId && perAgentPools.has(agentId)) scheduleIdleEviction(agentId, "per_agent");
  if (perSessionPools.has(sessionId)) scheduleIdleEviction(sessionId, "per_session");
}

// notifyTurnBegin cancels pending eviction for all applicable scopes:
function notifyTurnBegin(sessionId: string): void {
  if (!trackInstanceIdle) return;
  const agentId = parseAgentSessionUrn(sessionId)?.agentId;
  cancelIdleEviction("__global__", "global");
  if (agentId) cancelIdleEviction(agentId, "per_agent");
  cancelIdleEviction(sessionId, "per_session");
}
```

## Data Structures

### Per-Agent Pool Cache (internal)

```ts
// Keyed by agent ID
const perAgentMcpCtx = new Map<string, SessionMcpToolContext>();
const perAgentMcpClose = new Map<string, () => Promise<void>>();
const perAgentMcpConnect = new Map<string, Promise<SessionMcpToolContext>>();
```

## Code Examples

### Configuration

```yaml
mcp:
  poolScope: "per_agent" # default for servers that omit poolScope
  perInstanceIdleTimeoutMs: 1800000 # 30 min idle eviction for all pool instances
  servers:
    - id: "code-sandbox"
      transport: stdio
      command: "/usr/bin/sandbox-mcp"
      # poolScope: "inherit" → uses top-level "per_agent"
      # Spawned as agent UID/GID with HOME=<agent workspace>
    - id: "shared-docs"
      transport: http
      url: "http://docs-mcp:8080/mcp"
      poolScope: "global" # override: shared across all agents, daemon identity
```

### Per-Server Override

```yaml
mcp:
  poolScope: "global" # default
  perInstanceIdleTimeoutMs: 0 # disable idle eviction
  servers:
    - id: "isolated-fs"
      transport: stdio
      command: "/usr/bin/fs-mcp"
      poolScope: "per_agent" # agent UID/GID, HOME=<agent workspace>
    - id: "shared-search"
      transport: http
      url: "http://search:3000/mcp"
      # poolScope: "inherit" → uses top-level "global", daemon identity
```

### Effective Environment for Scoped Stdio Servers

```
# per_agent or per_session stdio server for agent "developer":
UID=900
GID=900
HOME=/var/lib/shoggoth/workspaces/developer
CWD=/var/lib/shoggoth/workspaces/developer  (unless server config specifies cwd)
+ any env vars from mcp.servers[].env merged on top
```
