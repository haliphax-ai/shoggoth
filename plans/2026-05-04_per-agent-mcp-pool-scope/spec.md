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

### Idle Timeout Config

A new optional field on `shoggothMcpConfigSchema`:

```ts
/**
 * After the last turn completes for any session belonging to an agent,
 * close that agent's per-agent MCP pool if no further turn completes
 * within this many milliseconds. `0` disables. Default: disabled (no eviction).
 */
perAgentIdleTimeoutMs: z.number().int().nonnegative().optional(),
```

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
  readonly trackPerSessionIdle: boolean;
  /** True when at least one server uses per_agent scope and perAgentIdleTimeoutMs > 0. */
  readonly trackPerAgentIdle: boolean;
}
```

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
    const baseEnv = agentCtx
      ? { HOME: agentCtx.workspacePath, ...s.env }
      : s.env;

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

  // 1. Global sources (daemon identity, already connected at boot)
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

## Data Structures

### Per-Agent Pool Cache (internal)

```ts
// Keyed by agent ID
const perAgentMcpCtx = new Map<string, SessionMcpToolContext>();
const perAgentMcpClose = new Map<string, () => Promise<void>>();
const perAgentMcpConnect = new Map<string, Promise<SessionMcpToolContext>>();
const perAgentMcpIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

## Code Examples

### Configuration

```yaml
mcp:
  poolScope: "per_agent" # default for servers that omit poolScope
  perAgentIdleTimeoutMs: 1800000 # 30 min idle eviction (optional)
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
