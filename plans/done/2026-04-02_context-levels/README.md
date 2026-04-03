---
date: 2026-04-02
status: planned
completed: never
---

# Context Levels

## Summary

Introduce four graduated context levels (`none`, `minimal`, `light`, `full`) that control how much system prompt content and which tools are provided to agents and subagents. Configurable at the top level, per-agent, and overridable at spawn time by agents or system processes (workflows, cron, heartbeat).

## Motivation

Every model turn currently receives the full system prompt: identity, persona, workspace template files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md, MEMORY.md, HEARTBEAT.md, TOOLS.md), operator global instructions, CLI docs, safety rules, stats, and the complete tool set. This is appropriate for interactive sessions but wasteful for workflow tasks, cron jobs, and other scoped operations that don't need persona, memory, or orchestration tools.

Workflow task subagents are the worst case: each spawned task pays the full system prompt cost in a fresh session, contributing to timeouts and unnecessary token burn. A `minimal` or `light` context level would cut the prompt size significantly and reduce the tool surface to only what the task needs.

## Design

### Context Levels

| Level | System Prompt Content | Tools |
|---|---|---|
| `none` | Empty — raw model, no Shoggoth framing | None |
| `minimal` | Identity (basic), trusted system envelope, safety, runtime | Filtered (see below) |
| `light` | Everything in `full` except bootstrap, personality-shaping, and memory template files | All tools |
| `full` | Current behavior — all sections, all template files | All tools |

#### `none`

No system prompt. No tools. The model receives only the user message. Use case: raw model access for simple completions where Shoggoth framing is unnecessary overhead.

#### `minimal`

The agent knows it's running inside Shoggoth and understands the trusted system envelope, but has no persona, no workspace files, and a reduced tool set. Sections included:

- `buildIdentitySection` (basic Shoggoth identity)
- `buildSafetySection`
- `buildTrustedSystemContextGuidance`
- `buildToolingSection` (filtered tool list)
- `buildRuntimeSection`

Sections excluded:

- All workspace template files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md)
- Operator global instructions (GLOBAL.md)
- CLI & docs reference
- Memory config hint
- Heartbeats guidance
- Silent replies guidance
- Reaction guidance
- Session stats

Default tool exclusions at `minimal`:

- `workflow` (workflow orchestration)
- `subagent` (subagent spawning)
- All session commands except `send` (no `list`, `history`, `spawn`)

#### `light`

Full agent context minus the files that shape personality, bootstrap behavior, and memory. The agent has its operational instructions and tools but not the "who am I" layer.

Template files included:

- `AGENTS.md`
- `TOOLS.md`
- `HEARTBEAT.md`

Template files excluded:

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md`
- `MEMORY.md`

All other system prompt sections are included. All tools are available.

#### `full`

Current behavior. All sections, all template files, all tools.

### Configuration Schema

Context levels are configurable at the top level and per-agent. Tool availability per level is overridable at the top level.

```typescript
interface ContextLevelToolOverride {
  /** Additional tools to allow at this level (added to defaults). */
  allow?: string[];
  /** Additional tools to exclude at this level (added to defaults). */
  exclude?: string[];
}

// Top-level config additions
interface ShoggothConfig {
  /** Override default tool availability per context level. */
  contextLevelTools?: {
    none?: ContextLevelToolOverride;
    minimal?: ContextLevelToolOverride;
    light?: ContextLevelToolOverride;
    // `full` has no exclusions by default; `exclude` can restrict it.
    full?: ContextLevelToolOverride;
  };

  agents?: {
    /** Default context level for top-level agent sessions. Default: "full". */
    contextLevel?: "none" | "minimal" | "light" | "full";
    /** Default context level for subagent sessions. Default: "light". */
    subagentContextLevel?: "none" | "minimal" | "light" | "full";

    list?: {
      [agentId: string]: {
        /** Context level for this agent's own sessions. */
        contextLevel?: "none" | "minimal" | "light" | "full";
        /** Context level for subagents spawned by this agent. */
        subagentContextLevel?: "none" | "minimal" | "light" | "full";
      };
    };
  };
}
```

Example configuration:

```json
{
  "contextLevelTools": {
    "minimal": { "allow": ["workflow"] }
  },
  "agents": {
    "contextLevel": "full",
    "subagentContextLevel": "light",
    "list": {
      "exampleAgentId": {
        "contextLevel": "light",
        "subagentContextLevel": "none"
      }
    }
  }
}
```

### Resolution Order

When determining the context level for a session, the following precedence applies (highest first):

1. **Explicit spawn parameter** — passed at spawn time by the parent agent or system process
2. **Per-agent config** — `agents.list[agentId].subagentContextLevel` (for subagents) or `agents.list[agentId].contextLevel` (for the agent itself)
3. **Top-level config** — `agents.subagentContextLevel` (for subagents) or `agents.contextLevel` (for agents)
4. **Default** — `full` for top-level agents, `light` for subagents

### Spawn-Time Override

The `contextLevel` parameter is accepted when spawning subagents, allowing agents and system processes to override the configured default on a case-by-case basis:

```typescript
interface SpawnSessionInput {
  // ... existing fields (agentId, platform, resourceType, parentSessionId,
  //     modelSelection, lightContext, etc.) ...
  /** Override the context level for this subagent session. */
  contextLevel?: "none" | "minimal" | "light" | "full";
}
```

System processes that should use this:

- **Workflow task spawner** — defaults to `minimal` unless overridden by config
- **Cron job spawner** — configurable per job, defaults to resolved agent config
- **Heartbeat** — defaults to `light` (needs HEARTBEAT.md but not full persona)

### Tool Filtering

Tool filtering is applied after the context level is resolved. The flow:

1. Start with the full tool set for the session
2. Apply default exclusions for the resolved context level
3. Apply `contextLevelTools[level].exclude` from config (additional exclusions)
4. Apply `contextLevelTools[level].allow` from config (re-allow specific tools)

Default exclusions by level:

| Level | Default Excluded Tools |
|---|---|
| `none` | All tools |
| `minimal` | `workflow`, `subagent`, `session-list`, `session-history`, `session-spawn` |
| `light` | None |
| `full` | None |

### System Prompt Builder Changes

`buildSessionSystemContext` gains a `contextLevel` parameter. The function uses it to gate which sections are assembled:

```typescript
interface BuildSessionSystemContextInput {
  // ... existing fields ...
  readonly contextLevel?: "none" | "minimal" | "light" | "full";
}
```

The template file loop gains a filter based on context level:

```typescript
const TEMPLATE_FILES_BY_LEVEL: Record<string, Set<string>> = {
  none: new Set(),
  minimal: new Set(),
  light: new Set(["AGENTS.md", "TOOLS.md", "HEARTBEAT.md"]),
  full: new Set(WORKSPACE_TEMPLATE_FILES),
};
```

Section inclusion by level:

| Section | `none` | `minimal` | `light` | `full` |
|---|---|---|---|---|
| Identity | — | ✓ | ✓ | ✓ |
| CLI & docs | — | — | ✓ | ✓ |
| Tooling | — | ✓ | ✓ | ✓ |
| Safety | — | ✓ | ✓ | ✓ |
| Trusted context | — | ✓ | ✓ | ✓ |
| Workspace root | — | — | ✓ | ✓ |
| Memory hint | — | — | — | ✓ |
| Operator global | — | — | ✓ | ✓ |
| Template files | — | — | filtered | all |
| Heartbeats | — | — | ✓ | ✓ |
| Silent replies | — | — | ✓ | ✓ |
| Reaction guidance | — | — | ✓ | ✓ |
| Runtime | — | ✓ | ✓ | ✓ |
| Stats | — | — | — | ✓ |
| Env appendix | — | — | ✓ | ✓ |

## Implementation Phases

### Phase 1: Context Level Type and Resolution

Define the context level type, add it to the config schema, and implement the resolution chain (spawn param → per-agent → top-level → default).

- Define `ContextLevel` type
- Add `contextLevel`, `subagentContextLevel`, `contextLevelTools` to config schema
- Implement `resolveContextLevel(config, agentId, spawnOverride, isSubagent): ContextLevel`
- Validate config values at load time

**Files:**
- `packages/shared/src/schema.ts`
- `packages/shared/src/config.ts` (or wherever config resolution lives)

### Phase 2: System Prompt Builder Gating

Add `contextLevel` to `BuildSessionSystemContextInput` and gate section assembly based on the resolved level.

- Add `contextLevel` field to input interface
- Gate section builders behind level checks
- Filter template file loop by level
- `none` returns empty string

**Files:**
- `packages/daemon/src/sessions/session-system-prompt.ts`

### Phase 3: Tool Filtering

Apply tool exclusions based on context level and config overrides.

- Implement `filterToolsByContextLevel(tools, level, config): Tool[]`
- Wire into MCP tool context assembly
- Apply default exclusions per level
- Apply config `contextLevelTools` allow/exclude overrides

**Files:**
- `packages/daemon/src/sessions/session-mcp-tool-context.ts`
- `packages/daemon/src/sessions/session-mcp-runtime.ts`

### Phase 4: Spawn-Time Parameter

Add `contextLevel` to the subagent spawn interface and wire it through session creation.

- Add `contextLevel` to `SpawnSessionInput` (alongside the existing `resourceType` field added since this plan was written)
- Store resolved context level on the session row
- Pass through to `buildSessionSystemContext` and tool filtering
- Note: `platform-discord` now uses a consolidated `formatAssistantReply` helper and extracted `formatAdhocReactionEventContext`/`formatGlobalReactionEventContext` helpers (the inline `formatDegradedPrefix`/`formatModelTagFooter` calls no longer exist)

**Files:**
- `packages/daemon/src/sessions/session-manager.ts`
- `packages/daemon/src/sessions/session-store.ts`
- `packages/platform-discord/src/platform.ts`

### Phase 5: System Process Integration

Wire context level into workflow task spawner, cron, and heartbeat.

- Workflow task spawner: default `minimal`, configurable
- Cron job spawner: per-job `contextLevel` field
- Heartbeat: default `light`
- Pass `contextLevel` through spawn adapters
- Note: `createWorkflowNotifier`'s `notify` signature now accepts `{ replyTo: string; aborted?: boolean }` context and branches into success/aborted/failed paths with distinct guidance strings. Context level wiring must account for this three-way branching.

**Files:**
- `packages/daemon/src/workflow-adapters.ts`
- `packages/daemon/src/sessions/session-agent-turn.ts`

## Testing Strategy

- Unit test `resolveContextLevel` with all precedence combinations (spawn override, per-agent, top-level, defaults)
- Unit test `buildSessionSystemContext` at each level — verify correct sections present/absent
- Unit test tool filtering with default exclusions and config overrides
- Unit test config validation rejects invalid level strings
- Integration test: spawn a workflow task subagent at `minimal` and verify the system prompt is significantly smaller than `full`
- Manual verification: run a workflow and confirm tasks complete faster with reduced context

## Considerations

- The `none` level is intentionally extreme — it's useful for raw model access but agents won't understand Shoggoth conventions (tool calling, trusted context, etc.). Document this clearly.
- `minimal` excludes workspace root info, so agents won't know their working directory. This is fine for tasks that receive explicit paths in their prompt but could surprise agents that assume workspace context.
- The `light` level excludes MEMORY.md but includes AGENTS.md. If AGENTS.md references memory-dependent behavior, the agent may be confused. Operators should be aware of this when writing AGENTS.md.
- Heartbeat currently needs HEARTBEAT.md to know what to check. The default `light` level for heartbeat includes it. If someone overrides heartbeat to `minimal`, the heartbeat prompt content must be self-contained.
- Tool filtering happens at the MCP context level, not the model level. The model won't see excluded tools in its tool list, so it can't attempt to call them.
- `contextLevelTools` overrides are additive/subtractive from defaults, not replacements. This keeps the config simple — you don't need to re-specify the full default exclusion list to add one tool.

## Migration

No data migration required. Context level defaults to `full` for top-level agents and `light` for subagents, preserving current behavior for agents while improving subagent performance out of the box. The `contextLevelTools` config key is optional and has no effect until set.

Session rows may gain a `context_level` column to persist the resolved level. This is a schema addition, not a migration of existing data — existing sessions default to `full`.
