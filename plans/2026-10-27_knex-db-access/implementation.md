# Implementation

Phased for independent delegation: additive work first, integration later; each phase ends with `typecheck` + tests green. Red/green TDD per phase (write/adjust the failing test first). Never run `npm install` in a way that mutates the main checkout's `node_modules` — see Phase 1 install note (worktree symlinks).

## Phase 1: knex foundation + starter migration (the breaking change)

Adds the shared-connection knex layer, merges the 24 legacy migrations into one starter, rewrites the migrator, and makes every `migrate()` call site async. Owns fixing ALL tests broken by the migration-format change.

- **TDD/red first:** rewrite `persistence.test.ts` for knex semantics (see below), plus new `db/knex.test.ts` cases.
- `db/knex.ts`: `getKnex`/`getRawDb`/`createKnex` + single-connection pool adapter.
- **Validation gate (run before anything else):** a migration file under `migrations/` loaded and executed by `knex.migrate.latest()` under `node --import tsx/esm`. If `.ts` loading fails, stop and switch to the custom-`migrationSource` fallback from `spec.md`.
- Build `migrations/initial_schema.sql` by concatenating `0001…0024` in order; script it once (ordered `cat`), then verify by migrating a fresh DB with the **old** runner and the **new** starter and diffing `sqlite_master` output — must be identical.
- `migrations/20261027000000_initial_schema.ts` (`up` = exec merged SQL; `down` = drop all created objects, test asserts empty schema).
- Delete the 24 legacy `migrations/NNNN_*.sql` files.
- Rewrite `db/migrate.ts`: async `migrate(db, migrationsDir?)` per `spec.md`, plus the collapsed helpers `openMigratedStateDb()` and `migrateStateDb()` (exported from `lib.ts`); legacy `_schema_migrations` guard; `defaultMigrationsDir`/`assertMigrationsDirReadable` unchanged.
- Collapse the 4 entry-point call sites: daemon `index.ts` and the 3 CLI files become `const db = await openMigratedStateDb(config.stateDbPath)` (CLI `assertMigrationsDirReadable`/`defaultMigrationsDir` imports drop away).
- Mechanical `await` sweep: `migrateStateDb(db)` replaces `migrate(db, defaultMigrationsDir())` in ~90 test files (grep-driven; TS will flag non-async callbacks).
- Add knex `^3.3.0` to `packages/daemon/package.json` (CLI scaffold usage may add a root devDependency in Phase 6). After installing, verify the worktree's `node_modules` symlinks still resolve (worktree script warning: never `npm install` against the main checkout's install).
- Update `docs/daemon.md` migration paragraphs.
- `knip.json`: keep `scripts/**` ignored; ensure the new migration dir isn't flagged.

**Test contract changes:** `appliedVersions` becomes migration _names_ (assert single `20261027000000_initial_schema` on first run, `[]` on second); add: starter `down` empties schema; missing-`down` migration rejected (knex's own validation); legacy `_schema_migrations` guard throws; knex + raw handle share `:memory:` state; `knex.destroy()` doesn't close the handle; WAL survives knex use.

**Files:** `packages/daemon/src/db/knex.ts`, `packages/daemon/src/db/migrate.ts`, `packages/daemon/src/index.ts`, `packages/cli/src/run-{retention,events-dlq,session-compact}.ts`, `migrations/*`, `packages/daemon/test/db/{persistence.test.ts,knex.test.ts}`, ~90 test files (await sweep), `packages/daemon/package.json`, `docs/daemon.md`.

**Delegable?** No — this is the keystone; do it in-session (or as a single subagent with the full spec).

## Phase 2: small independent stores → knex

Converts self-contained modules with few call sites; validates the conversion pattern end-to-end.

- `service-key-store.ts` (interface in `spec.md`), `service-approval-store.ts`, `acpx/sqlite-acpx-bindings.ts`, `hitl/yolo-mode-store.ts`, `provider-failure-store.ts`, `sessions/re-read-required.ts`, `auth/sqlite-agent-tokens.ts` (+ its `db.transaction` → knex transaction).
- Each module's methods become `async`; update direct callers and the modules' tests.

**Files:** 7 `src` files + their tests under `packages/daemon/test/`.

**Delegable?** Yes — split into 2–3 subagents by module group.

## Phase 3: high-traffic stores

- `sessions/transcript-store.ts`, `session-store.ts` (incl. its generic `sql` query helper), `tool-run-store.ts`, `session-stats-store.ts`, `session-tool-discovery.ts`, `agents-md-gate.ts`, `sessions/session-mcp-runtime.ts`.
- `status-bar.ts` queries follow their store inputs.
- Watch: prepared-statement caching lost — keep hot loops on `knex.raw` builders; note any tool-loop latency delta.

**Files:** ~8 `src` files + `test/sessions/*`, `test/presentation/status-bar.test.ts`.

**Delegable?** Yes — 2 subagents (transcript/session core vs. stats/discovery), sequenced if they share `session-store.ts`.

## Phase 4: HITL, elevation, timers, exec notifies

- `hitl/pending-actions-store.ts`, `hitl/hitl-session-tool-auto-store.ts`, `hitl/hitl-auto-approve-persisting.ts` (+ stack), `elevation/elevation-store.ts`, `timers/timer-scheduler.ts`, `exec/exec-notify-scheduler.ts`.
- Cross-cutting: these feed the tool loop and schedulers — run `tool-loop*.test.ts` and `*-scheduler.test.ts` after each module.

**Files:** ~7 `src` files + `test/hitl/*`, `test/elevation/*`, `test/timers/*`, `test/exec/*`, `test/sessions/tool-loop*.test.ts`.

**Delegable?** Yes — one subagent (cohesive surface), or two (pending-actions/elevation vs. timers/exec).

## Phase 5: events, vault, retention + sync-transaction elimination

- `events/events-queue.ts`, `events/cron-scheduler.ts`, `events/dlq.ts`, `events/heartbeat-consumer.ts`, `events/boot-reconciliation.ts`.
- `vault/vault-service-impl.ts` (its `db.transaction` → knex), `retention/retention-jobs.ts` (3 transactions), `transcript-compact.ts`, `sessions/session-manager.ts` transaction, `memory/memory-index.ts` (+ `builtin-memory-tools.ts`, `memory/rerank` — `knex.raw` for FTS/vector SQL), `audit/append-audit.ts`.
- **Exit criterion for this phase:** zero `db.transaction(` calls remain in `packages/*/src` — all transactions flow through knex (shared-connection invariant from README Considerations).

**Files:** ~15 `src` files + `test/events/*`, `test/vault/*`, `test/retention/*`, `test/memory/*`, `test/audit/*`.

**Delegable?** Yes — split events vs. vault/retention/memory.

## Phase 6: remaining call sites, tooling, cleanup, PR

- Discord platform (`platform-discord/src/plugin.ts` 4 queries) and remaining daemon leaf queries (`tool-loop.ts`, `session-agent-turn.ts`, `builtin-handlers/{kv,timer,session}-handler.ts`, `presentation/status-bar.ts` leftovers, `workflow-adapters.ts`).
- Root `knexfile.mjs` + `npm run migrate:make` script for standard scaffolding (Phase 1 deferment); document in `docs/daemon.md`/`plans`.
- Remove `@types/better-sqlite3`-only leftovers where erased (keep types where the handle type is still the currency — it is, so keep both deps), run `npx knip`, confirm `_schema_migrations` has zero references.
- Final gate: `npx vitest run`, `npx lerna run typecheck --parallel`, `npx oxlint --deny-warnings .`, `npx oxfmt --no-error-on-unmatched-pattern .`, `npx knip`; coverage thresholds hold.
- Commit sequence (conventional commits, hooks allowed to run): foundation → per-phase conversions → docs/cleanup. Push triggers full typecheck via hooks. Open PR referencing issue #333.

**Files:** remaining `src` files with `.prepare(`, `knexfile.mjs`, `package.json`, `docs/*`.

**Delegable?** Yes — cleanup split; PR opening stays with the parent session.
