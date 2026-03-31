# Plan: Stateful Session Stats

Track session-level metadata as persistent counters/accumulators in SQLite, updated inline as events occur. Read path is a single row lookup — no aggregation queries.

## Schema

New table `session_stats` (1:1 with `sessions`):

```sql
CREATE TABLE session_stats (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  turn_count INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  context_window_tokens INTEGER,          -- model's max context, set on first turn
  first_turn_at TEXT,                     -- ISO timestamp of first agent turn
  last_turn_at TEXT,                      -- ISO timestamp of most recent agent turn
  last_compacted_at TEXT,                 -- ISO timestamp of most recent compaction
  transcript_message_count INTEGER NOT NULL DEFAULT 0,  -- current messages in active segment
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Why a separate table instead of columns on `sessions`:
- `sessions` is already wide and touched by many code paths
- Stats updates are high-frequency (every turn) — isolating them reduces contention risk
- Clean migration (additive, no ALTER TABLE)

## Write points

### After each agent turn (`session-agent-turn.ts`)
- Increment `turn_count`
- Add `input_tokens` and `output_tokens` from the model response (these are already returned by the provider — `complete()` and `completeWithTools()` return usage when the provider supplies it)
- Update `last_turn_at`
- Set `context_window_tokens` on first turn if not already set (from the model config or provider response)
- Update `transcript_message_count` (count of messages in current context segment)

### After compaction (`transcript-compact.ts` / `session_compact` control op)
- Increment `compaction_count`
- Update `last_compacted_at`
- Recalculate `transcript_message_count` (compaction reduces message count)

### On context new / reset (`session-context-segment.ts`)
- Reset `turn_count` to 0
- Reset `input_tokens` to 0
- Reset `output_tokens` to 0
- Reset `transcript_message_count` to 0
- Preserve `compaction_count`, `context_window_tokens`, `first_turn_at` (lifetime stats)

## Read points

### Control op: `session_stats`
New integration op that returns the stats row for a given session. Operator or owning agent principal.

### System prompt (optional, phase 2)
Inject a `## Session Stats` section into the runtime metadata block:
```
Tokens used: 12,450 / 128,000 (9.7%) · Turns: 23 · Compactions: 1 · Duration: 2h14m
```

This gives the LLM awareness of how much context budget remains — useful for self-managing compaction hints or adjusting verbosity.

### Slash command: `/stats`
New Discord slash command that calls `session_stats` and returns a formatted embed.

## Token tracking detail

The model provider layer already returns usage in some cases:
- OpenAI: `response.usage.prompt_tokens` / `completion_tokens`
- Anthropic: `response.usage.input_tokens` / `output_tokens`
- Gemini: `usageMetadata.promptTokenCount` / `candidatesTokenCount`

Where the provider doesn't return usage (e.g. streaming without usage reporting), fall back to `estimateTokens()` which already exists in the codebase.

The stats row tracks cumulative totals. Per-turn breakdown can be derived from the audit log if needed later.

## Migration

New migration `0004_session_stats.sql`:
```sql
CREATE TABLE session_stats (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  turn_count INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  context_window_tokens INTEGER,
  first_turn_at TEXT,
  last_turn_at TEXT,
  last_compacted_at TEXT,
  transcript_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Row is lazily created (upsert on first write) — no backfill needed for existing sessions.

## Files touched

- `migrations/0004_session_stats.sql` — new table
- `packages/daemon/src/sessions/session-stats-store.ts` — new: CRUD for session_stats (upsert pattern)
- `packages/daemon/src/sessions/session-agent-turn.ts` — update stats after each turn; set context_window_tokens from provider response
- `packages/daemon/src/sessions/context-window-mismatch.ts` — new: in-memory once-per-provider mismatch tracking + warning emission (stderr + platform surface)
- `packages/daemon/src/transcript-compact.ts` — update stats after compaction
- `packages/daemon/src/sessions/session-context-segment.ts` — reset per-segment counters on new/reset
- `packages/daemon/src/control/integration-ops.ts` — add `session_stats` op
- `packages/daemon/src/policy/engine.ts` — register `session_stats` in known ops
- `packages/daemon/src/platforms/platform-command.ts` — add `stats` command mapping
- `packages/platform-discord/src/slash-commands.ts` — add `/stats` slash command
- `packages/daemon/src/sessions/session-system-prompt.ts` — (phase 2) inject stats into runtime section
- `packages/shared/src/schema.ts` — add `runtime.suppressContextWindowMismatchNotice` config option

## Phases

1. Schema + store + write points (turn, compaction, context ops)
2. Control op + slash command
3. System prompt injection

## Decisions

### Token counter resets
`input_tokens`, `output_tokens`, `turn_count`, and `transcript_message_count` reset on both `session_context_new` and `session_context_reset` control ops. This covers all entry points (slash commands, CLI, direct control socket calls).

### Context window tokens source
`context_window_tokens` is set from the provider's response metadata where available (e.g. OpenAI `x-ratelimit-*` headers, Anthropic usage metadata, Gemini `usageMetadata`). Falls back to the model config value when the provider doesn't report it.

**Mismatch warning:** When the config specifies a context window size AND the provider response reports a different value, emit a warning:
- Always log to stderr (non-suppressible)
- Surface to the session's message platform binding (e.g. Discord channel) once per provider (tracked in-memory only, not persisted — resets on daemon restart)
- Add a system-level config option (`runtime.suppressContextWindowMismatchNotice` or similar) to disable the platform-surfaced warning (does NOT suppress the stderr log entry)

### Total cost
Not implemented. Leave a `// TODO: total_cost — requires per-model pricing tables` comment in the session-stats-store where the column would go.
