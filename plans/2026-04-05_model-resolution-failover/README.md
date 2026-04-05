---
date: 2026-04-05
completed: never
---

# Model Resolution & Provider Failover

Separate model definitions from failover chains, persist provider failure state in the DB, and make retry/failover behavior configurable at both global and per-provider levels.

## Motivation

Model definitions and failover chain entries are currently the same object. When an agent overrides its failover chain (even just to set a different model), properties like `contextWindowTokens` are silently dropped because the override replaces the entire chain entry. This caused mid-turn compaction to never trigger for the main agent — the `contextWindowTokens` field was lost in the merge, so the compaction budget check always saw `undefined` and skipped.

Beyond that, the current failover logic is stateless and in-memory. Every turn re-discovers failures from scratch. There's no persistence of which providers are down, no configurable retry behavior, and no way to mark a provider as temporarily failed so other sessions can skip it immediately.

## Design

### Core Concepts

**Provider** — An API endpoint that serves model requests. Has an `id`, `kind` (anthropic-messages, openai-compatible, gemini), `baseUrl`, auth config, and a list of **model definitions**.

**Model Definition** — A model available on a provider. Has a `name`, `contextWindowTokens`, optional `thinkingFormat`, and any other model-level properties. Lives under the provider, not the failover chain.

**Failover Chain** — An ordered list of `"<providerId>/<model>"` references. Exists at the global level and can be overridden per-agent. Contains no model properties — those are resolved from the provider's model definitions.

**Provider Failure** — A DB-persisted record that a provider failed and exhausted its retries. Has a `providerId`, `failedAt` timestamp, and optional error context. Used by the model resolution helper to skip known-bad providers.

### Schema Changes

```ts
// Provider schema — models move here
const providerModelSchema = z.object({
  name: z.string().min(1),
  contextWindowTokens: z.number().int().positive().optional(),
  thinkingFormat: z.enum(["native", "xml-tags", "none"]).optional(),
});

const providerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openai-compatible", "anthropic-messages", "gemini"]),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  apiVersion: z.string().optional(),
  models: z.array(providerModelSchema).optional(), // NEW
  // Retry/failure config (per-provider, overrides global)
  maxRetries: z.number().int().nonneg().optional(),
  retryDelayMs: z.number().int().nonneg().optional(),
  retryBackoffMultiplier: z.number().positive().optional(),
  markFailedDurationMs: z.number().int().positive().optional(),
});

// Failover chain entry — simplified to a reference
const failoverChainEntrySchema = z.union([
  z.string().min(1), // "providerId/model"
  z.object({
    ref: z.string().min(1), // "providerId/model"
    // Per-hop invocation overrides (temperature, etc.) if needed
  }),
]);

// Global retry/failure config
const modelsRetrySchema = z.object({
  maxRetries: z.number().int().nonneg().optional(),       // default 2
  retryDelayMs: z.number().int().nonneg().optional(),     // default 1000
  retryBackoffMultiplier: z.number().positive().optional(), // default 2
  markFailedDurationMs: z.number().int().positive().optional(), // default 60000 (60s)
});
```

### DB Schema

New table in the state DB:

```sql
CREATE TABLE IF NOT EXISTS provider_failures (
  provider_id TEXT PRIMARY KEY,
  failed_at   TEXT NOT NULL,  -- ISO-8601 timestamp
  error       TEXT,           -- optional error context
  retry_count INTEGER NOT NULL DEFAULT 0
);
```

### Model Resolution Helper

```ts
interface ResolvedModel {
  provider: ProviderConfig;
  model: ProviderModelDefinition;
  ref: string; // "providerId/model"
}

/**
 * Resolves a model reference to its full definition.
 * If no ref is given, uses the agent default or global default.
 * Walks the failover chain if the target provider is marked as failed.
 */
function resolveModel(
  db: Database.Database,
  config: ShoggothModelsConfig,
  opts?: {
    ref?: string;           // explicit "providerId/model"
    sessionId?: string;     // for agent-level defaults
    agentConfig?: AgentModelsConfig;
  },
): ResolvedModel | null;
```

Resolution algorithm:

1. Determine the target model ref:
   - If `ref` is provided, use it
   - Otherwise, use the agent's default (first entry in agent failover chain) or global default (first entry in global failover chain)

2. Look up the provider by `providerId` from the ref

3. Check `provider_failures` for the provider:
   - If failed and `now - failed_at < markFailedDurationMs` → provider is down, skip to step 4
   - If failed and `now - failed_at >= markFailedDurationMs` → failure is stale, clear it, try this provider

4. If the provider is down, find its position in the failover chain:
   - If the ref exists in the chain, start from the next entry
   - If the ref does not exist in the chain, start from the top
   - Walk the chain until a non-failed provider is found or the chain is exhausted

5. If the chain is exhausted, return `null` and log a warning (do not halt)

6. Resolve the model definition from the provider's `models` list by name

### Provider Failure Tracking

When a model provider throws an error and exhausts its retries:

```ts
function markProviderFailed(
  db: Database.Database,
  providerId: string,
  error?: string,
): void;

function clearProviderFailure(
  db: Database.Database,
  providerId: string,
): void;

function getProviderFailure(
  db: Database.Database,
  providerId: string,
): { failedAt: Date; error?: string; retryCount: number } | null;

function isProviderFailed(
  db: Database.Database,
  providerId: string,
  markFailedDurationMs: number,
): boolean; // true if failed and not stale
```

### Retry Behavior

Retry config is resolved with per-provider overrides taking precedence over global:

```ts
function resolveRetryConfig(
  globalRetry: RetryConfig | undefined,
  providerRetry: Partial<RetryConfig> | undefined,
): RetryConfig;
// Returns { maxRetries: 2, retryDelayMs: 1000, retryBackoffMultiplier: 2 } as defaults
```

The failover client retries within a single provider up to `maxRetries` times with exponential backoff (`retryDelayMs * retryBackoffMultiplier^attempt`). Only after exhausting retries does it mark the provider as failed and move to the next chain entry.

### Agent-Level Failover Chains

Agent failover chains become simple reference lists:

```json
{
  "agents": {
    "list": {
      "main": {
        "models": {
          "failoverChain": ["kiro/minimax-m2.5", "kiro/auto-kiro"]
        }
      }
    }
  }
}
```

The `primary` shorthand is removed. Agent chains override the global chain order but model properties always resolve from the provider's model definitions — no more silent property loss.

`resolveEffectiveModelsConfig` merges the agent chain with the global providers. The agent can only reorder/subset the chain; model definitions are immutable at the provider level.

## Implementation Phases

### Phase 1: Schema & DB Migration

Define the new schema types and add the `provider_failures` table.

- Add `models` array to provider schema
- Add `providerModelSchema` for model definitions
- Simplify failover chain entry schema to string refs (keep backward compat with object form during transition)
- Add `modelsRetrySchema` for global retry config
- Add per-provider retry/failure fields to provider schema
- Add `provider_failures` table migration
- Update schema tests

**Files:**
- `packages/shared/src/schema.ts`
- `migrations/0002_provider_failures.sql` (or next migration number)
- `packages/shared/test/schema.test.ts`

### Phase 2: Provider Failure Store

Implement the DB-backed provider failure tracking.

- `markProviderFailed(db, providerId, error?)`
- `clearProviderFailure(db, providerId)`
- `getProviderFailure(db, providerId)`
- `isProviderFailed(db, providerId, durationMs)`
- Unit tests with in-memory SQLite

**Files:**
- `packages/daemon/src/sessions/provider-failure-store.ts` (new)
- `packages/daemon/test/sessions/provider-failure-store.test.ts` (new)

### Phase 3: Model Resolution Helper

Implement the core resolution function that walks the failover chain with failure awareness.

- `resolveModel(db, config, opts?)` — resolves a model ref to its full definition
- `resolveRetryConfig(global, provider)` — merges retry config
- Lookup model definitions from provider's `models` list
- Failover chain walking with stale failure clearing
- Exhausted chain returns null + warning log
- Unit tests covering: happy path, failed provider skip, stale failure clear, chain exhaustion, missing model definition fallback

**Files:**
- `packages/daemon/src/sessions/model-resolution.ts` (new)
- `packages/daemon/test/sessions/model-resolution.test.ts` (new)

### Phase 4: Wire Failover Client to New Resolution

Update `createFailoverToolCallingClient` and `createFailoverModelClient` to use the new resolution helper and mark providers as failed after retry exhaustion.

- Replace inline failover chain walking with `resolveModel` calls
- After retry exhaustion, call `markProviderFailed`
- On success after a previous failure, call `clearProviderFailure`
- Pass `db` through to the failover client (new dependency)
- Resolve `contextWindowTokens` from the provider's model definition, not the chain entry
- Update existing failover tests

**Files:**
- `packages/models/src/from-config.ts`
- `packages/models/src/resilience/failover.ts`
- `packages/models/test/from-config.test.ts`
- `packages/models/test/resilience/failover.test.ts`

### Phase 5: Update Consumers

Update all code that reads model properties from failover chain entries to use the resolution helper instead.

- `session-agent-turn.ts` — `contextWindowTokens` lookup via resolved model
- `session-tool-loop-model-client.ts` — compaction config uses resolved model properties
- `resolveEffectiveModelsConfig` — agent chains become ref lists, model properties resolved from providers
- `platform.ts` — model resolution for platform-level operations
- `run-session.ts` (CLI) — model resolution

**Files:**
- `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/src/sessions/session-tool-loop-model-client.ts`
- `packages/shared/src/effective-agent-for-session.ts`
- `packages/platform-discord/src/platform.ts`
- `packages/cli/src/run-session.ts`

### Phase 6: Config Migration & Backward Compatibility

Support both old and new config formats during transition.

- If a failover chain entry has inline model properties (old format), extract them into the provider's `models` list at config load time with a deprecation warning
- If `primary` is set on an agent's models config, convert to a single-entry failover chain ref
- Update config validation to accept both formats
- Update docs

**Files:**
- `packages/shared/src/schema.ts` (migration logic)
- `packages/shared/src/config-compat.ts` (new, optional)
- `docs/models.md`

## Testing Strategy

- **Phase 1:** Schema validation tests — new fields accepted, old fields still work
- **Phase 2:** Provider failure store — mark, clear, stale detection, concurrent access
- **Phase 3:** Model resolution — chain walking, failure skipping, stale clearing, exhaustion, edge cases (empty chain, unknown provider, unknown model)
- **Phase 4:** Failover client integration — retry exhaustion marks failure, success clears failure, DB state persists across calls
- **Phase 5:** Consumer integration — `contextWindowTokens` resolves correctly for agent overrides, compaction triggers for agents with `primary` model overrides
- **Phase 6:** Config migration — old format auto-converts, deprecation warnings logged

All phases use red/green TDD.

## Considerations

- **Performance:** The resolution helper hits the DB on every `complete()` call to check provider failures. This is a single-row lookup by primary key on a tiny table — negligible overhead. If it becomes a concern, an in-memory cache with short TTL could be added.
- **Race conditions:** Multiple sessions may try to mark/clear the same provider simultaneously. SQLite's serialized writes handle this, but the `INSERT OR REPLACE` pattern should be used for idempotency.
- **Backward compatibility:** The old inline-property format must work during transition. The migration logic in Phase 6 handles this transparently.
- **`primary` shorthand removal:** Agents currently use `primary: { providerId, model }` as a shorthand for a single-entry chain. This becomes `failoverChain: ["providerId/model"]`. The old format is auto-converted.
- **Environment fallback:** The env-var-based single-hop fallback (`OPENAI_BASE_URL`, etc.) should continue to work when no config is present. The synthetic provider it creates should include a model definition with sensible defaults.
- **Deferred:** Per-model retry config (as opposed to per-provider) is not included in this plan. If needed, it can be added later by extending the model definition schema.

## Migration

- **DB:** New `provider_failures` table added via migration. No existing data affected.
- **Config:** Old failover chain format (inline model properties) auto-converts at load time. No manual config changes required immediately, but a deprecation warning is logged. The old `primary` shorthand on agent models config is also auto-converted.
- **State:** No state files invalidated. The provider failure table starts empty — all providers are assumed healthy on first boot after upgrade.
