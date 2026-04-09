---
date: 2026-04-09
completed: never
---

# MCP Integration Gaps

## Summary

Close the remaining gaps in external MCP server integration: per-session idle timeout / refcount for MCP pools, standing GET SSE resumption, and a new allow/deny filtering system for MCP server ids at four configuration levels (global, per-agent, global subagents, per-agent subagents).

## Motivation

External MCP servers are fully wired (stdio, TCP, streamable HTTP), but three gaps remain:

1. **Per-session pool idle timeout** — the schema defines `perSessionIdleTimeoutMs` and `SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS`, and `session-mcp-runtime.ts` has the timer scaffolding, but the eviction only fires on `stop()`. Long-lived sessions with per-session MCP pools hold connections open indefinitely with no idle reclaim.

2. **Standing GET SSE resumption** — the streamable HTTP client sends `Last-Event-ID` on POST retries but does not resume the standing GET loop with `Last-Event-ID` after a disconnect. Servers that deliver responses exclusively via the GET stream may lose messages on reconnect.

3. **MCP server allow/deny filtering** — there is no way to selectively enable or disable configured MCP servers by id. All configured servers are connected and advertised unconditionally. Operators need the ability to temporarily disable a server globally, restrict which servers an agent sees, or limit subagent access — following the same allow/deny merge pattern used by policy tool rules and HITL.

## Design

### 1. Per-session MCP pool idle timeout

`session-mcp-runtime.ts` already has `perSessionMcpIdleTimers`, `schedulePerSessionMcpIdleTimer`, and `evictPerSessionMcpIdlePool`. The `notifyTurnEnd` callback schedules the timer; `notifyTurnBegin` cancels it. The runtime exposes `trackPerSessionIdle` so callers know whether to invoke the notify hooks.

**Current state:** The timer infrastructure works. The gap is that platform turn orchestrators must call `notifyTurnBegin` / `notifyTurnEnd` at the right points. Verify that `turn-orchestrator.ts` (or equivalent) calls these hooks around every inbound turn, including error paths and aborts. If not, wire them in.

**Eviction behavior on fire:**
- Close all MCP sessions in the per-session pool for that `sessionId`.
- Unregister the cancel handler.
- Clear the cached `SessionMcpToolContext` so the next turn reconnects lazily.
- Log `session.mcp_pool.idle_evicted`.

**Reconnect on next turn:** When a turn arrives for an evicted session, `resolveContext` finds no cached context and triggers a fresh `connectShoggothMcpServers` — same as the initial lazy connect path.

### 2. Standing GET SSE resumption

In `mcp-streamable-http-transport.ts`, `runStandingGetLoop` reconnects after errors but does not pass `Last-Event-ID`. The fix:

- Track `lastSseEventId` (already a module-level variable updated by both POST and GET SSE parsing).
- On GET reconnect (top of the `while` loop), if `lastSseEventId` is set, include it as a `Last-Event-ID` request header on the GET fetch.
- This mirrors the POST retry behavior already implemented in `readSseRpcFromPostBodyWithRetry`.

**Edge cases:**
- Servers that never send `id:` fields: no header sent, behavior unchanged.
- Servers that don't honor `Last-Event-ID` on GET: they replay from their own cursor; client dispatches as normal (duplicate responses hit `pending` map misses and route to `onServerMessage`).

### 3. MCP server allow/deny filtering

#### 3.1 Configuration shape

A new `McpServerRules` type, analogous to `ShoggothToolRules` but simpler (no `review` tier):

```typescript
const mcpServerRulesSchema = z.object({
  allow: z.array(z.string()),  // MCP server ids or "*"
  deny: z.array(z.string()),   // MCP server ids or "*"
}).strict();

type McpServerRules = z.infer<typeof mcpServerRulesSchema>;
```

Default: `{ allow: ["*"], deny: [] }` — all servers available.

Evaluation follows the same deny-wins pattern as `evaluateRules` in `policy/engine.ts`:
1. If `deny` matches → excluded.
2. If `allow` matches → included.
3. Otherwise → excluded (default-deny).

#### 3.2 Configuration levels

Four levels, each optional. When omitted, the level inherits the parent's effective rules.

| Level | Config path | Applies to |
|---|---|---|
| Global | `mcp.serverRules` | All sessions (top-level and subagent) |
| Per-agent | `agents.list.<id>.mcp.serverRules` | That agent's top-level sessions |
| Global subagents | `agents.subagentMcp.serverRules` | All subagent sessions (default) |
| Per-agent subagents | `agents.list.<id>.subagentMcp.serverRules` | Subagents spawned by that agent |

#### 3.3 Resolution order

```
resolveEffectiveMcpServerRules(config, agentId, isSubagent) → McpServerRules
```

1. Start with the global rules: `config.mcp.serverRules ?? { allow: ["*"], deny: [] }`.
2. If the session is a subagent:
   a. Merge global subagent rules: `config.agents.subagentMcp.serverRules` (per-field replace when present).
   b. Merge per-agent subagent rules: `config.agents.list.<agentId>.subagentMcp.serverRules` (per-field replace when present).
3. If the session is a top-level agent session:
   a. Merge per-agent rules: `config.agents.list.<agentId>.mcp.serverRules` (per-field replace when present).

"Per-field replace" means the same merge strategy as `resolveEffectiveToolRules`: if the narrower scope provides `allow`, it replaces the inherited `allow`; same for `deny`. Fields not provided at the narrower scope inherit from the broader scope.

#### 3.4 Filtering integration point

Filtering happens in `resolveContext` inside `session-mcp-runtime.ts`, after the MCP pool is connected but before the `SessionMcpToolContext` is built. The resolved rules determine which `sourceId`s are visible:

```
allExternalSources → filter by effective rules → buildSessionMcpToolContext(filtered)
```

The `ExternalMcpInvoke` callback also checks the rules: if a `tools/call` targets a denied `sourceId`, it returns `mcp_server_denied` without hitting the MCP session.

**Important:** Filtering does not affect which servers are *connected* — only which are *advertised and callable*. This keeps pool management simple (connect everything configured; filter at the context layer). A denied server's pool stays warm so re-enabling it via dynamic config doesn't require a reconnect.

#### 3.5 Schema changes

In `packages/shared/src/schema.ts`:

```typescript
// New schema
export const mcpServerRulesSchema = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
}).strict();

export type McpServerRules = z.infer<typeof mcpServerRulesSchema>;

// Add to shoggothMcpConfigSchema:
//   serverRules: mcpServerRulesSchema.optional()

// Add to shoggothAgentEntrySchema:
//   mcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional()

// Add to shoggothAgentsConfigSchema:
//   subagentMcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional()

// Add to shoggothAgentEntrySchema:
//   subagentMcp: z.object({ serverRules: mcpServerRulesSchema.optional() }).strict().optional()
```

#### 3.6 Example configurations

**Globally disable a server:**
```json
{
  "mcp": {
    "servers": [
      { "id": "indexer", "transport": "stdio", "command": "mcp-indexer" },
      { "id": "sandbox", "transport": "stdio", "command": "mcp-sandbox" }
    ],
    "serverRules": { "allow": ["*"], "deny": ["sandbox"] }
  }
}
```

**Restrict an agent to specific servers:**
```json
{
  "agents": {
    "list": {
      "researcher": {
        "mcp": {
          "serverRules": { "allow": ["indexer"], "deny": [] }
        }
      }
    }
  }
}
```

**Deny all external MCP for subagents globally:**
```json
{
  "agents": {
    "subagentMcp": {
      "serverRules": { "allow": [], "deny": ["*"] }
    }
  }
}
```

**Per-agent subagent override (allow one server):**
```json
{
  "agents": {
    "subagentMcp": {
      "serverRules": { "allow": [], "deny": ["*"] }
    },
    "list": {
      "builder": {
        "subagentMcp": {
          "serverRules": { "allow": ["sandbox"], "deny": [] }
        }
      }
    }
  }
}
```

## Implementation Phases

### Phase 1: Per-session MCP pool idle timeout

- Verify `notifyTurnBegin` / `notifyTurnEnd` are called in `turn-orchestrator.ts` on all paths (success, error, abort).
- Wire the calls if missing.
- Add a test that connects a per-session pool, fires a turn, waits past the idle timeout, and confirms the pool is evicted and the context cache is cleared.
- Verify reconnect works after eviction.

**Files:**
- `packages/daemon/src/presentation/turn-orchestrator.ts`
- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/test/sessions/session-mcp-runtime.test.ts` (new or extend)

### Phase 2: Standing GET SSE resumption

- In `runStandingGetLoop`, pass `Last-Event-ID: lastSseEventId` on the GET fetch when the value is set.
- Add a test with a mock HTTP server that sends `id:` fields on SSE events, disconnects, and verifies the client reconnects with the correct `Last-Event-ID` header.

**Files:**
- `packages/mcp-integration/src/mcp-streamable-http-transport.ts`
- `packages/mcp-integration/test/mcp-streamable-http-transport.test.ts` (extend)

### Phase 3: MCP server allow/deny — schema and resolution

- Add `mcpServerRulesSchema` and `McpServerRules` type to `packages/shared/src/schema.ts`.
- Add `serverRules` to `shoggothMcpConfigSchema`.
- Add `mcp` and `subagentMcp` fields to `shoggothAgentEntrySchema`.
- Add `subagentMcp` to `shoggothAgentsConfigSchema`.
- Add `resolveEffectiveMcpServerRules(config, agentId, isSubagent)` to `packages/shared/src/resolve.ts` (or wherever the other `resolveEffective*` functions live).
- Add `evaluateMcpServerRules(serverId, rules)` — same deny-wins logic as `evaluateRules`.
- Unit test the resolution and evaluation functions.

**Files:**
- `packages/shared/src/schema.ts`
- `packages/shared/src/index.ts` (re-export)
- `packages/shared/src/resolve.ts` (or equivalent — wherever `resolveEffectiveModelsConfig` etc. live)
- `packages/shared/test/resolve.test.ts` (new or extend)

### Phase 4: MCP server allow/deny — runtime filtering

- In `session-mcp-runtime.ts` `resolveContext`, after building the tool context, filter `externalSources` by the resolved rules for the current `sessionId`.
- Wrap the `ExternalMcpInvoke` callback to reject calls to denied `sourceId`s with `mcp_server_denied`.
- Create a context finalizer (or inline in `resolveContext`) that strips denied servers' tools from the `SessionMcpToolContext`.
- Integration test: configure two MCP servers, deny one for an agent, verify only the allowed server's tools appear and `tools/call` to the denied server returns the error.

**Files:**
- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/src/sessions/session-mcp-tool-context.ts`
- `packages/daemon/test/sessions/session-mcp-runtime.test.ts` (extend)
- `packages/daemon/test/mcp/mcp-server-rules.test.ts` (new)

## Testing Strategy

- **Phase 1:** Unit test idle timer scheduling, eviction, and reconnect. Mock `connectShoggothMcpServers` to track connect/close calls. Verify timer is cancelled on `notifyTurnBegin` and rescheduled on `notifyTurnEnd`.
- **Phase 2:** Mock HTTP server that tracks `Last-Event-ID` headers on GET requests. Simulate disconnect and verify the header is present on reconnect.
- **Phase 3:** Pure unit tests for `resolveEffectiveMcpServerRules` covering all four levels, omitted fields, and the merge cascade. Unit tests for `evaluateMcpServerRules` covering deny-wins, wildcard, and default-deny.
- **Phase 4:** Integration test with `createSessionMcpRuntime` using injected `connectShoggothMcpServers`. Configure two servers, apply rules, verify filtered tool lists and invoke rejection.

## Considerations

- **Pool warmth vs. resource usage:** Denied servers stay connected so re-enabling is instant. If resource usage becomes a concern (many configured but denied servers), a future optimization could defer connection for globally-denied servers. Not in scope here.
- **Dynamic config reload:** When `serverRules` change via hot-reload, the next `resolveContext` call picks up the new rules automatically (rules are resolved per-call, not cached). No pool reconnect needed.
- **`tools/list` refresh:** If a denied server's `tools/list` changes while denied, the stale catalog is used when re-enabled. This is the same staleness issue that exists today for all MCP servers and is tracked separately.
- **Fragment schema:** The `shoggothConfigFragmentSchema` needs the same optional fields added so layered config and dynamic config can set `serverRules`.

## Migration

No data migration required. The new config fields are all optional with defaults that preserve current behavior (`allow: ["*"], deny: []`). Existing configurations work unchanged.
