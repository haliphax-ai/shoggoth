---
date: 2026-04-04
completed: never
---

# Dynamic tool discovery — collapsible tool catalog with auto-trigger

## Summary

Replace the flat, always-full tool list with a **discover/enable/disable** meta-tool that keeps the model's `tools` array small by default. Tools not in an "always-on" set are collapsed into a lightweight catalog inside the meta-tool's description. The model calls `builtin-discover` to enable tools on demand; enabled tools appear in the `tools` array on the **next model round** within the same tool loop. Operator config controls which tools are excluded from collapse (always-on) globally and per agent, and defines **trigger phrases** that auto-enable matching tools when detected in a user message.

## Motivation

Shoggoth currently advertises every resolved tool (builtins + MCP) on every `complete()` call. With 20+ builtins and growing MCP catalogs, the tool definitions alone consume thousands of tokens per model round — context that's wasted when the model only uses 2–3 tools in a typical turn.

The existing `session-tool-advertising-design.md` doc captures the agreed direction but leaves implementation open. This plan makes it concrete.

Key wins:

- **Token savings.** Collapsed tools contribute only `name: one-line description` to the meta-tool schema instead of full JSON Schema `parameters` blocks. For 20 tools averaging ~400 tokens each, that's ~7,000 tokens saved per round when most are collapsed.
- **Reduced model confusion.** Fewer tools in the `tools` array means fewer irrelevant options for the model to consider, improving tool selection accuracy.
- **Operator control.** Always-on sets and trigger phrases let operators tune the tradeoff between discoverability and context cost per deployment.

## Design

### Core concepts

1. **Tool state per session**: each tool is either **enabled** (full schema in `tools` array) or **collapsed** (name + description only, listed inside the `builtin-discover` tool description).
2. **Always-on set**: tools that are never collapsed. Configured globally and per agent. The meta-tool itself (`builtin-discover`) is implicitly always-on.
3. **Trigger phrases**: keyword/pattern → tool ID mappings. When a user message contains a trigger phrase, the matched tools are auto-enabled for that turn's tool loop before the first `complete()`.
4. **Mid-loop refresh**: after `builtin-discover` executes, the tool list is refreshed before the next `complete()` in `runToolLoop`. This is the "medium lift" item from the design doc.

### `builtin-discover` tool schema

```ts
interface DiscoverToolParams {
  /** Tool IDs to enable for this session. */
  readonly enable?: string[];
  /** Tool IDs to disable (collapse) for this session. */
  readonly disable?: string[];
  /** When true, list all available tools with their current state. */
  readonly list?: boolean;
}

interface DiscoverToolResult {
  readonly applied: {
    readonly enabled: string[];
    readonly disabled: string[];
    readonly rejected: Array<{ id: string; reason: string }>;
  };
  /** Present when list: true. */
  readonly catalog?: Array<{
    id: string;
    description: string;
    enabled: boolean;
    alwaysOn: boolean;
  }>;
}
```

**Batch semantics**: enable + disable in one call. Unknown IDs and policy-blocked tools return structured rejections per ID (not a batch failure). Always-on tools silently ignore disable requests (returned in `rejected` with reason `"always_on"`).

### Meta-tool description injection

When collapsed tools exist, the `builtin-discover` tool's `description` field is dynamically augmented with a compact catalog:

```
Manage which tools are active. Collapsed tools (call with enable to activate):
- builtin-exec: Execute a command with cwd at workspace root
- builtin-fetch: Make an HTTP request
- builtin-workflow: Orchestrate parallel and sequential subagent workflows
- myserver-query: Query the database
...
Call with {enable: ["builtin-exec"]} to add tools to your active set.
```

This keeps the catalog visible to the model without paying the cost of full `parameters` schemas.

### Config schema

New top-level config key `toolDiscovery` and per-agent override:

```ts
// In shoggothConfigFragmentSchema
toolDiscovery: z.object({
  /** When true, tool discovery/collapse is active. Default: false (all tools advertised). */
  enabled: z.boolean().optional(),
  /** Tool IDs that are never collapsed (always in the tools array). */
  alwaysOn: z.array(z.string().min(1)).optional(),
  /** Trigger phrases: when a user message contains the key string (case-insensitive),
   *  the listed tool IDs are auto-enabled for that turn. */
  triggers: z.array(z.object({
    /** Case-insensitive substring or /regex/ pattern to match in user messages. */
    match: z.string().min(1),
    /** Tool IDs to auto-enable when matched. */
    tools: z.array(z.string().min(1)),
  })).optional(),
}).strict().optional();

// In shoggothAgentEntrySchema
toolDiscovery: z.object({
  /** Per-agent always-on additions (merged with global). */
  alwaysOn: z.array(z.string().min(1)).optional(),
  /** Per-agent trigger additions (merged with global). */
  triggers: z.array(z.object({
    match: z.string().min(1),
    tools: z.array(z.string().min(1)),
  })).optional(),
  /** Per-agent override: set false to disable discovery for this agent even when globally enabled. */
  enabled: z.boolean().optional(),
}).strict().optional();
```

**Resolution order** (layered, matching existing patterns):
1. Global `toolDiscovery.enabled` → per-agent `toolDiscovery.enabled` (per-agent wins when set).
2. Always-on: global set ∪ per-agent set ∪ implicit (`builtin-discover`).
3. Triggers: global list ++ per-agent list (concatenated; all evaluated).

### Session tool state persistence

New SQLite table for the session-level tool enable/disable overlay:

```sql
CREATE TABLE IF NOT EXISTS session_tool_state (
  session_id  TEXT NOT NULL,
  tool_id     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tool_id)
);
```

On session creation, no rows exist — the resolver uses the default (collapsed for non-always-on tools). When `builtin-discover` enables/disables a tool, it upserts into this table. The state survives daemon restarts.

### Tool resolution pipeline

Today's flow in `session-mcp-tool-context.ts`:

```
buildAggregatedMcpCatalog → context finalizers → SessionMcpToolContext
```

New flow:

```
buildAggregatedMcpCatalog → context finalizers → applyToolDiscovery → SessionMcpToolContext
```

`applyToolDiscovery` is a new finalizer registered in `createSessionMcpRuntime` (like the context-level and web-search finalizers). It:

1. Checks if discovery is enabled (resolved config for this session's agent).
2. Loads the session's tool state from `session_tool_state`.
3. Evaluates trigger phrases against the current user message (passed via a session-scoped ref, similar to `messageToolContextRef`).
4. Partitions tools into enabled (full schema) and collapsed (name + description only).
5. Builds the `builtin-discover` tool descriptor with the dynamic catalog in its description.
6. Returns a new `SessionMcpToolContext` with only enabled tools + the discover tool.

**Important**: the full aggregated catalog (all tools) must remain available to the **executor/router** so that when a tool is enabled mid-loop, it can be dispatched. The split is:
- `toolsOpenAi` / `toolsLoop` → only enabled tools (what the model sees).
- `aggregated` → full catalog (what the executor can route to).

This matches the design doc's "advertised ⊆ executable" invariant.

### Mid-loop tool refresh

Today, `createSessionToolLoopModelClient` captures `input.tools` once and passes the same array on every `complete()`. To support mid-loop refresh:

1. Change `tools` in the model client from a fixed array to a **getter function** `() => readonly OpenAIToolFunctionDefinition[]`.
2. The getter is backed by a mutable ref that `session-agent-turn.ts` can update.
3. After `builtin-discover` executes, the handler signals that the tool list changed (via a callback on `BuiltinToolContext` or a session-scoped event).
4. The turn logic re-runs `applyToolDiscovery` to produce a new `toolsOpenAi` and updates the ref.
5. The next `complete()` in `runToolLoop` picks up the new tools.

The `runToolLoop` `options.tools` (the name allowlist) must also be refreshable — same pattern: getter or mutable ref. The loop already re-checks `names.has(tc.name)` per tool call, so the allowlist just needs to be current.

**Refresh trigger**: after `builtin-discover` execution only (not after every tool). The handler returns a side-channel signal; the tool loop checks for it after each tool result.

### Trigger phrase evaluation

Evaluated once at the start of `executeSessionAgentTurn`, before the first `complete()`:

1. Resolve effective triggers (global + per-agent).
2. For each trigger, test `match` against the user message content (case-insensitive substring; if wrapped in `/…/`, treat as regex).
3. Collect matched tool IDs, deduplicate.
4. Upsert into `session_tool_state` as enabled.
5. These tools appear in the first `complete()` call's tool list.

Trigger-enabled tools persist in the session state — they don't auto-disable after the turn. The model (or operator) can disable them later via `builtin-discover`.

### Subagent inheritance

Subagents inherit the parent session's resolved tool state at spawn time (snapshot). They do not get their own `builtin-discover` tool by default — consistent with the design doc's "inherit parent mask" rule. A future plan can add independent subagent discovery if needed.

### Relationship to context levels

Context-level filtering runs **before** tool discovery. If a context level excludes a tool, it's not in the aggregated catalog at all and cannot be discovered. Discovery only operates on tools that survive context-level filtering.

### Relationship to policy

Policy is enforced at execution time in `runToolLoop`, not at advertisement time. A tool can be enabled via discover but still blocked by policy when called. The discover tool's `rejected` array reports policy-blocked tools so the model knows not to try.

## Implementation Phases

### Phase 1: Config schema and session tool state table

Add the `toolDiscovery` config schema, per-agent override, and the `session_tool_state` migration.

**Files:**
- `packages/shared/src/schema.ts` — add `toolDiscovery` to config and agent entry schemas
- `migrations/0008_session_tool_state.sql` — new migration

### Phase 2: Tool discovery resolver (finalizer)

Implement the `applyToolDiscovery` finalizer that partitions tools into enabled/collapsed and builds the dynamic `builtin-discover` descriptor.

**Files:**
- `packages/daemon/src/sessions/session-tool-discovery.ts` — new: resolver logic, state read/write helpers, trigger evaluation
- `packages/daemon/src/sessions/session-mcp-runtime.ts` — register the new finalizer
- `packages/daemon/src/sessions/session-mcp-tool-context.ts` — extend `SessionMcpToolContext` with `fullAggregated` field (all tools for executor routing)

### Phase 3: `builtin-discover` handler

Implement the tool handler that enables/disables/lists tools and signals a mid-loop refresh.

**Files:**
- `packages/daemon/src/sessions/builtin-handlers/discover-handler.ts` — new: handler implementation
- `packages/daemon/src/sessions/builtin-handlers/index.ts` — register
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — base tool descriptor (description is dynamic, but the schema is static)

### Phase 4: Mid-loop tool refresh

Make the model client's tool list refreshable and wire the refresh signal from the discover handler through the tool loop.

**Files:**
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts` — change `tools` to getter; add `refreshTools()` method
- `packages/daemon/src/sessions/tool-loop.ts` — add refresh hook after tool execution; update `allowedNames` to re-evaluate on refresh
- `packages/daemon/src/sessions/session-agent-turn.ts` — wire refresh callback that re-runs discovery resolver and updates model client

### Phase 5: Trigger phrase evaluation

Wire trigger phrase matching into the turn entry point so matched tools are auto-enabled before the first `complete()`.

**Files:**
- `packages/daemon/src/sessions/session-tool-discovery.ts` — add `evaluateTriggers()` export
- `packages/daemon/src/sessions/session-agent-turn.ts` — call `evaluateTriggers()` before tool loop, pass user content

## Testing Strategy

- **Config resolution:** global-only, per-agent override, per-agent disable, merged always-on sets, merged triggers.
- **Session tool state:** enable/disable round-trip via DB, state survives simulated restart (re-read from DB), always-on tools reject disable.
- **Discovery finalizer:** tools correctly partitioned; discover tool description contains collapsed catalog; enabled tools have full schemas; `fullAggregated` contains all tools.
- **`builtin-discover` handler:** enable unknown tool → rejected; enable valid tool → applied; disable always-on → rejected with reason; batch enable+disable; list returns full catalog with states.
- **Mid-loop refresh:** after discover call, next `complete()` sees updated tool list; tool loop allowlist updated; enabled tool can be called immediately after discover.
- **Trigger phrases:** substring match, regex match, case-insensitive, multiple triggers, dedup, matched tools appear in first `complete()`, persist in session state.
- **Subagent inheritance:** spawned subagent inherits parent's enabled set; no discover tool in subagent tools list.
- **Context level interaction:** tool excluded by context level not discoverable; tool allowed by context level but collapsed is discoverable.
- **Policy interaction:** tool enabled via discover but policy-denied → rejected in discover result; tool enabled and policy-allowed → callable.

## Considerations

- **Backward compatibility.** `toolDiscovery.enabled` defaults to `false`. Existing deployments see zero behavior change until an operator opts in. This is critical — the feature should be purely additive.
- **Token accounting.** The dynamic catalog in the discover tool's description grows linearly with collapsed tool count. For very large MCP catalogs (50+ tools), consider paginating or truncating the catalog and adding a `search` parameter to the discover tool. Deferred to a future iteration.
- **Race conditions.** Mid-loop refresh is synchronous within the tool loop's `for (;;)` — no concurrent `complete()` calls. The refresh happens between tool result processing and the next `complete()`, so there's no race.
- **MCP tool volatility.** If an MCP server's `tools/list` changes between discover-enable and actual call, the executor may fail. This is the same problem that exists today and is tracked in the design doc under "MCP servers and disconnect."
- **Discover tool in system prompt.** The system prompt should mention that tools can be discovered/enabled. This is an operator concern (system prompt template), not a code change — but worth documenting.
- **Phase ordering.** Phases 1–3 can be implemented and tested without mid-loop refresh (the enabled tools would only take effect on the next turn). Phase 4 adds same-turn refresh. Phase 5 is independent of Phase 4.

## Migration

- **Phase 1** adds a `session_tool_state` table via a new migration. No existing data affected.
- Phases 2–5 require no migrations.
- No state wipe needed. Existing sessions with no rows in `session_tool_state` behave as if all tools are in their default state (collapsed for non-always-on when discovery is enabled).
