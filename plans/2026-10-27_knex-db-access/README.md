---
date: 2026-10-27
completed: never
---

# knex for DB access and migrations

## Summary

Replace the hand-rolled numbered-`.sql` migration runner and direct `better-sqlite3` query calls with `knex`: merge the 24 existing migrations into a single starter migration, run future migrations through knex's standard process, and convert data access to knex's query builder in independently shippable phases.

## Motivation

Schema management currently lives in 24 ad-hoc `migrations/NNNN_*.sql` files applied by a bespoke runner (`src/db/migrate.ts`) with its own bookkeeping table. Queries are hand-written SQL strings executed with `better-sqlite3`'s `.prepare()` spread across ~50 modules. Neither has the guarantees of a mature DB abstraction layer: knex provides a battle-tested migrator (transactions, locking, bookkeeping, `up`/`down` discipline, scaffolding) and a query builder/schema builder that gives us one consistent, parameterized data-access style.

## Design

### Key decisions

1. **`better-sqlite3` stays as the driver; knex becomes the access layer.**
   knex ships a first-class `better-sqlite3` dialect. We keep the driver so WAL mode, FTS5 virtual tables, `loadExtension` (tiered-memory vector search), and the online-backup API continue to work unchanged. All _schema_ and _query construction_ goes through knex from here on.

2. **One shared connection — knex wraps the handle we already have.**
   The daemon opens the state DB once (`openStateDb`) and passes that handle through the system; tests frequently use `:memory:`, where a _second_ connection would see an empty database. knex's official `connectionPool` option (knex ≥ 3.3.0) lets us supply a tiny tarn-compatible pool that always yields the existing handle. knex becomes an async facade over the single synchronous connection; `knex.destroy()` never closes the underlying handle (external pools are not owned by knex).

3. **The `better-sqlite3` handle remains the universal currency; modules obtain knex on demand.**
   `BuiltinToolContext.db`, store constructors, and test setup keep passing the raw handle. Converted modules call `getKnex(db)` (memoized in a `WeakMap`, reverse-mapped for raw access). This is what makes conversion incremental — no flag-day type change through the tool loop, and unconverted modules keep working with `.prepare()` until their phase lands.

4. **Migrations: one starter migration, then the standard knex process.**
   The 24 numbered SQL files concatenate (in order) into `migrations/initial_schema.sql`, applied by a single starter migration module `migrations/20261027000000_initial_schema.ts`. Because the legacy runner applied the files sequentially inside transactions, concatenation in the same order yields an identical schema by construction. Bookkeeping moves to knex's `knex_migrations` / `knex_migrations_lock`; `_schema_migrations` and the custom runner disappear. Future migrations are scaffolded with `knex.migrate.make()` (wrapped in an npm script, see `spec.md`).
   The repeated per-entry-point open/migrate sequence collapses into two helpers: `openMigratedStateDb(path)` for the daemon and the three CLI programs, `migrateStateDb(db)` for tests and callers that already hold a handle. No caller passes `defaultMigrationsDir()` explicitly anymore (see `spec.md`).

5. **Async is contagious — conversion is phased, not flag-day.**
   knex's builder only returns promises; the codebase's `.prepare().run()` calls are synchronous and sit on hot paths (tool loop, event queue, schedulers). Each subsystem is converted in its own phase, keeping `typecheck` + tests green at every step, so phases can be delegated to subagents/PRs independently.

6. **Raw SQL is still allowed — through knex.**
   Highly dynamic or FTS/vector-specific SQL (e.g. the memory index `MATCH` queries) converts to `knex.raw(sql, bindings)` rather than being forced through the builder. "Use knex" means knex manages connections, transactions, and query construction — not that every statement must be builder syntax.

### Structure

```
packages/daemon/src/db/
  knex.ts       # getKnex(db), createKnex(db, opts), shared-connection pool adapter (new)
  migrate.ts    # rewritten: async migrate(); openMigratedStateDb()/migrateStateDb() helpers; defaultMigrationsDir(); assertMigrationsDirReadable()
  open.ts       # unchanged (WAL/journal pragmas on the shared handle)
  backup.ts     # unchanged (better-sqlite3 online backup API)
migrations/
  20261027000000_initial_schema.ts   # starter migration (up/down), reads the merged SQL
  initial_schema.sql                 # concatenation of legacy 0001..0024
  (24 legacy NNNN_*.sql files removed)
```

The starter migration runs inside knex's transaction and applies the merged SQL with `exec()` on the underlying connection (better-sqlite3's `prepare()` rejects multi-statement SQL, and the schema contains `BEGIN…END` trigger bodies that cannot be split naively).

### Knex configuration (contract lives in [`spec.md`](spec.md))

- `client: "better-sqlite3"`, `useNullAsDefault: true`
- `connectionPool`: single-connection adapter (duck-typed tarn pool: `acquire/release/destroy/numFree/numUsed/numPendingAcquires`)
- `migrations: { directory: <repo migrations dir>, loadExtensions: [".ts"] }`

## Testing Strategy

Repo mandates red/green TDD; git hooks run affected tests on commit and full typecheck on push.

- **Phase 1 (foundation):**
  - Shared-pool tests: knex and the raw handle observe the _same_ `:memory:` database; `knex.destroy()` does not close the handle; file-backed DBs stay in WAL mode after knex use.
  - Rewritten `test/db/persistence.test.ts`: starter applies exactly once (second run applies nothing), required tables present (`sqlite_master` via `knex.raw`), a migration missing `down` is rejected, WAL + backup tests unchanged.
  - Mechanical `await migrate(...)` sweep verified by `typecheck` (TS flags every non-async callback) plus full test run.
- **Phases 2–5 (conversion):** each store keeps its existing behavioral tests, rewritten only where the sync call surface changes; each phase runs its package's tests + typecheck before moving on.
- **Phase 6:** full `npx vitest run`, `npx lerna run typecheck --parallel`, `npx oxlint --deny-warnings .`, `npx knip`, coverage thresholds still met.

## Considerations

- **Single shared connection ⇒ knex transactions are process-global.** While a knex transaction is open, no other code may run queries on the same handle outside that transaction (SQLite has no per-transaction connection objects). Phases convert every `db.transaction(fn)` call site (transcript-compact, session-manager, events-queue, sqlite-agent-tokens, vault-service-impl, retention-jobs, memory-index) so that _all_ transactions eventually go through knex; until a phase lands, its sync transactions are only safe while no knex transaction is in flight (true today and during startup, where migrations run before anything else).
- **Hot-path overhead.** Statement-preparation caching (`const stmt = db.prepare(...)` reused across calls) is lost for converted modules; queries are recompiled through the driver each time. Acceptable for now; escape hatch is keeping hot loops on `.prepare()` or caching `knex.raw` builders. Revisit if tool-loop latency regresses.
- **`tsx` is retained for this work (decision 2026-10-27).** Native Node type stripping (Node ≥ 22.18/24; image is already `node:24`) would require flipping to `nodenext` resolution, adding `.ts` to ~1,200+ relative imports, and refactoring ~9 parameter-property constructors — a separate "drop-tsx" plan, deliberately decoupled from this one. Migration files are written in erasable syntax so they will load identically under either runtime later.
- **`.ts` migration loading under `tsx` is the main technical unknown.** knex's default loader dynamic-imports migration files; Phase 1 validates this under `node --import tsx/esm` _first_ (red test → green). Fallback (documented in `spec.md`): a custom `migrationSource` using our own dynamic `import()`.
- **Existing state DBs must be recreated.** Pre-release convention already says "replace state DB on schema change"; old DBs carry `_schema_migrations`, and the starter would fail against them. Optional guard: throw a clear "state DB predates the knex migrator — recreate it" error if `_schema_migrations` exists.
- **Scope excluded:** `packages/service-canvas`'s separate `a2ui` database (its own driver version and inline table creation) and `scripts/preview-context.ts` remain on direct `better-sqlite3` for now; they don't use the shared migrator. A follow-up can fold them in.
- **`better-sqlite3` is not removed from dependencies** — it is the knex dialect driver and is still used directly for pragmas, backup, and extension loading.
- **Dependency install in the worktree** must respect the worktree script's node_modules symlinking (never let `npm install` mutate the main checkout's install); Phase 1 includes a verification step after adding knex.
- **Performance/compat assumptions:** knex `^3.3.0` pinned (first release with `connectionPool`); `useNullAsDefault` required for SQLite inserts.

## Migration

- **Schema/data:** no data migration. The starter migration reproduces the current schema exactly; existing pre-release state databases are wiped on upgrade (repo convention). Docker deployments must recreate the state volume once when this lands.
- **Bookkeeping:** `_schema_migrations` → `knex_migrations` + `knex_migrations_lock` (created automatically on first run).
- **Code:** `migrate()` becomes async; every call site gains `await` (mechanical, Phase 1). Store internals convert per phase; public store method signatures stay synchronous until a phase makes them async — that phase owns updating its callers/tests.

## References

- [`spec.md`](spec.md) — interfaces, knex configuration, migration module format, conversion examples
- [`implementation.md`](implementation.md) — six phases with file lists, ordered for independent delegation
