# Persistent Subagents Refactor

## Goal

Rename "bound" subagents to "persistent" subagents throughout the codebase, and extend the concept so persistent subagents are no longer required to be bound to a platform thread. Persistent subagents without a thread binding should use internal agent-to-agent (A2A) delivery to communicate with their parent session.

## Scope

### 1. Rename "bound" → "persistent" everywhere

#### Types & Enums
- `packages/shared/src/schema.ts` — if any config schema references "bound"
- `packages/daemon/src/sessions/session-store.ts` — `SubagentMode = "one_shot" | "bound"` → `"one_shot" | "persistent"`

#### Constants
- `packages/daemon/src/subagent/subagent-constants.ts` — `SUBAGENT_DEFAULT_BOUND_LIFETIME_MS` → `SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS`

#### Tool Definitions
- `packages/mcp-integration/src/builtin-shoggoth-tools.ts` — `spawn_bound` → `spawn_persistent`, update all descriptions referencing "bound"

#### File Renames
- `packages/daemon/src/subagent/reconcile-persistent-bound-subagents.ts` → `reconcile-persistent-subagents.ts` (update exports, function name, type name)
- `packages/daemon/test/subagent/reconcile-persistent-bound-subagents.test.ts` → `reconcile-persistent-subagents.test.ts`
- `packages/daemon/src/notices/subagent-bound-ended-killed.md` → `subagent-persistent-ended-killed.md`
- `packages/daemon/src/notices/subagent-bound-ended-ttl.md` → `subagent-persistent-ended-ttl.md`

#### Core Logic Files (grep for "bound" and update)
- `packages/daemon/src/subagent/subagent-kill.ts` — `terminateBoundSubagentSession` → `terminatePersistentSubagentSession`
- `packages/daemon/src/subagent/subagent-disposables.ts`
- `packages/daemon/src/subagent/subagent-extension-ref.ts`
- `packages/daemon/src/sessions/session-agent-turn.ts`
- `packages/daemon/src/sessions/session-mcp-runtime.ts`
- `packages/daemon/src/sessions/session-segment-inline-command.ts`
- `packages/daemon/src/sessions/session-system-prompt.ts`
- `packages/daemon/src/messaging/inbound-session-turn.ts`
- `packages/daemon/src/control/integration-ops.ts`
- `packages/daemon/src/events/heartbeat-consumer.ts`
- `packages/daemon/src/retention/retention-jobs.ts`
- `packages/daemon/src/config-policy.ts`
- `packages/daemon/src/notices/load-notices.ts`
- `packages/daemon/src/index.ts`
- `packages/daemon/src/platforms/platform.ts`

#### CLI
- `packages/cli/src/run-subagent.ts`
- `packages/cli/src/run-session.ts`

#### Platform / Messaging
- `packages/platform-discord/src/*.ts` — all files referencing "bound"
- `packages/messaging/src/model.ts`, `platform.ts`, `capabilities.ts`

#### Tests (update all references)
- All test files listed in the grep output

#### Docs
- `docs/messaging.md`, `docs/acpx.md`, `docs/load-smoke.md`, `docs/session-tool-advertising-design.md`, etc.
- `README.md`, `AGENTS.md`
- `packages/messaging/README.md`

#### Prompts / Notices
- `packages/daemon/src/notices/subagent-bound-ended-killed.md` (rename + update content)
- `packages/daemon/src/notices/subagent-bound-ended-ttl.md` (rename + update content)

### 2. Extend persistent subagents to support threadless (A2A-only) mode

After the rename, the reconcile and spawn logic should be updated so that:

- `spawn_persistent` no longer requires `thread_id`. If `thread_id` is provided, behavior is the same as today (thread-bound persistent subagent). If omitted, the subagent is persistent but communicates via A2A delivery only.
- The reconcile function should handle both thread-bound and threadless persistent subagents. Currently it filters on `Boolean(s.subagentPlatformThreadId?.trim())` — threadless persistent subagents won't have this, so the filter needs to account for both cases.
- For threadless persistent subagents, skip `registerPlatformThreadBinding` but still do `subscribeSubagentSession` and TTL timer setup.
- The kill/terminate flow should work for both variants.
- Tool descriptions should document that `thread_id` is optional for `spawn_persistent`.

## Important Notes
- This is a prototype project — no backward compatibility needed
- SQLite migration: the `subagentMode` column stores "bound" as a string. A simple UPDATE statement in the migration or a note that DBs should be wiped is fine (prototype: wipe-on-change policy).
- Run `npm run build` from the repo root to verify compilation after changes.
- Run `npm test` from the repo root to verify tests pass.
- Do NOT install any new packages.
