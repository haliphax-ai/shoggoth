# Specification

Contract details for the knex adoption plan. `tsx` remains the runtime loader; native Node type stripping is explicitly out of scope (separate future plan).

## Interfaces

### Knex access layer — `packages/daemon/src/db/knex.ts` (new)

```ts
import type { Knex } from "knex";
import type Database from "better-sqlite3";

/**
 * Return the memoized knex facade for a better-sqlite3 handle.
 * First call wraps the handle; later calls return the same instance.
 * The returned knex must never be destroyed by callers — it does not
 * own the connection.
 */
export function getKnex(db: Database.Database): Knex;

/** Reverse lookup: the raw handle behind a knex facade (raw SQL escape hatch). */
export function getRawDb(knex: Knex): Database.Database;

/** Create a knex instance over an existing handle without memoizing (tests/CLI). */
export function createKnex(db: Database.Database, options?: KnexOptions): Knex;
```

Memoization uses a `WeakMap<Database.Database, Knex>` plus a reverse `WeakMap<Knex, Database.Database>`.

### Knex configuration

```ts
interface KnexOptions {
  /** Repo migrations directory (defaults to defaultMigrationsDir()). */
  readonly migrationsDir?: string;
}

// The config produced internally by createKnex():
{
  client: "better-sqlite3",
  useNullAsDefault: true,
  connectionPool: singleConnectionPool(db),   // adapter, see below
  migrations: {
    directory: migrationsDir,
    loadExtensions: [".ts"],
    disableMigrationsListValidation: false,
  },
}
```

### Single-connection pool adapter (duck-typed tarn pool)

```ts
interface SharedConnectionPool {
  acquire(): Promise<{ promise: Promise<Database.Database> }>;
  release(_conn: Database.Database): boolean;
  destroy(): Promise<void>; // no-op: never closes the shared handle
  numFree(): number; // always 1
  numUsed(): number; // always 0 (held externally)
  numPendingAcquires(): number; // always 0
}
```

- `acquire()` resolves immediately with the existing handle (knex ≥ 3.3.0 `connectionPool` option; duck-type match satisfies knex's `isTarnPool`).
- `destroy()` must NOT call `db.close()` — knex must never tear down the daemon's handle.
- Works for `:memory:` databases: knex and the app see the same connection, so tests keep passing their in-memory handles through unchanged.

## API / Function Signatures

### Migrator — `packages/daemon/src/db/migrate.ts` (rewritten)

```ts
interface MigrateResult {
  /** Migration names applied by this call (knex migration file names). */
  readonly appliedVersions: readonly string[];
}

/**
 * Apply all pending migrations via knex.migrate.latest().
 * Async — every existing call site gains `await`.
 * @throws if the legacy `_schema_migrations` table exists (pre-knex state DB).
 */
export async function migrate(
  db: Database.Database,
  migrationsDir?: string,
): Promise<MigrateResult>;

/** Repo `migrations/` directory (unchanged resolution logic). */
export function defaultMigrationsDir(): string;

/** Throws if the directory is missing (unchanged). */
export function assertMigrationsDirReadable(dir: string): void;
```

- `migrationsDir` becomes optional (defaults to `defaultMigrationsDir()`); existing two-argument call sites keep compiling.
- Legacy guard: on first run, if `_schema_migrations` exists and `knex_migrations` does not, throw `State DB predates the knex migrator; recreate the state database (pre-release schema).`
- Applied-name capture: `[first, last] = await knex.migrate.latest()`; the batch's applied names are the trailing entries of the completed list — implement via `knex.migrate.list()` diff or by reading `knex_migrations` rows inserted in this call (batch number from `latest()` result is the reliable signal).

### Collapsed entry-point helpers — `packages/daemon/src/db/migrate.ts` (new; exported via `lib.ts`)

```ts
/**
 * assertMigrationsDirReadable(defaultMigrationsDir()) + openStateDb + migrate.
 * The supported way for the daemon and CLI entry points to open the state DB:
 * no caller repeats the open/migrate dance or passes defaultMigrationsDir().
 */
export async function openMigratedStateDb(
  databasePath: string,
  options?: OpenStateDbOptions,
): Promise<Database.Database>;

/**
 * Same schema guarantee for a handle the caller already owns
 * (tests using `new Database(":memory:")`, ad-hoc tooling).
 * Defaults to defaultMigrationsDir() unless a directory is given.
 */
export async function migrateStateDb(
  db: Database.Database,
  migrationsDir?: string,
): Promise<MigrateResult>;
```

Call-site collapse (Phase 1):

| Before (per opener)                                                                                                    | After                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| daemon `index.ts`: `openStateDb(...)` then `migrate(db, defaultMigrationsDir())`                                       | `const db = await openMigratedStateDb(config.stateDbPath)` |
| 3 CLI files: `dir = defaultMigrationsDir(); assertMigrationsDirReadable(dir); db = openStateDb(...); migrate(db, dir)` | `const db = await openMigratedStateDb(config.stateDbPath)` |
| ~90 test files: `migrate(db, defaultMigrationsDir())`                                                                  | `await migrateStateDb(db)`                                 |

Low-level `migrate(db, migrationsDir?)` stays exported: the duplicate-version test passes a bad directory, and the persistence test drives it twice to assert idempotency. After the sweep no production call site passes `defaultMigrationsDir()` explicitly.

## Data Structures / Schemas

### Migration files

```ts
// migrations/20261027000000_initial_schema.ts
import type { Knex } from "knex";
import { readFileSync } from "node:fs";

const SCHEMA_SQL = readFileSync(new URL("./initial_schema.sql", import.meta.url), "utf8");

export async function up(knex: Knex): Promise<void> {
  // Merged legacy schema is multi-statement (incl. FTS triggers with
  // BEGIN...END bodies) — exec() it as one script on the raw connection.
  const db = getRawDb(knex); // or knex.client.driver-level handle
  db.exec(SCHEMA_SQL);
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the full schema on rollback: drop every object the starter created.
  // Simplest correct implementation: drop known tables (incl. fts/virtual/triggers).
}
```

**`down()` decision:** the starter's `down` drops every table it created (explicit list derived from `initial_schema.sql`, virtual tables and triggers included). Test asserts the database returns to empty schema. Subsequent migrations must implement real, reversible `down`s.

### `migrations/initial_schema.sql` (new)

Concatenation of legacy files `0001_schema.sql` … `0024_session_yolo_mode.sql` in ascending order, byte-for-byte content, with a header comment noting provenance. Build step documented in `implementation.md` Phase 1 (one-time, scripted, verified by comparing the resulting schema against a DB migrated by the old runner).

### Bookkeeping tables

- Created by knex: `knex_migrations` (`id`, `name`, `batch`, `migration_time`) and `knex_migrations_lock` (`index`, `is_locked`).
- Removed: `_schema_migrations` (code + docs).

## Code Examples

### Converting a module (pattern used by Phases 2–5)

```ts
// BEFORE (synchronous)
import type Database from "better-sqlite3";
export function getRecipient(db: Database.Database, serviceId: string): string | null {
  const row = db
    .prepare("SELECT recipient FROM service_keys WHERE service_id = ?")
    .get(serviceId) as { recipient: string } | undefined;
  return row?.recipient ?? null;
}

// AFTER (async, knex builder; caller gains `await`)
import type Database from "better-sqlite3";
import { getKnex } from "../db/knex";
export async function getRecipient(
  db: Database.Database,
  serviceId: string,
): Promise<string | null> {
  const row = await getKnex(db)<{ recipient: string }>("service_keys")
    .where("service_id", serviceId)
    .first();
  return row?.recipient ?? null;
}
```

Raw-SQL module (memory index FTS/vector queries) — same async change, knex.raw instead of builder:

```ts
const rows = await getKnex(db).raw<MemoryHit[]>(
  `SELECT ... FROM memory_fts JOIN memory_documents ... WHERE memory_fts MATCH ? ${rankExpr}`,
  [query],
);
```

### Transaction conversion

```ts
// BEFORE: const run = db.transaction(() => { ...; return result; }); const r = run(args);
// AFTER:
const r = await getKnex(db).transaction(async (trx) => {
  ...
  return result;
});
```

While a knex transaction is open, all statements on the shared handle run inside it — therefore every `db.transaction(...)` call site must be converted _together_ in the phase that introduces knex transactions for that subsystem (see `README.md` Considerations).

### Adding a future migration (documented workflow, phase 6)

```bash
npx knex migrate:make <name> -x ts --knexfile <repo>/knexfile.mjs
```

`knexfile.mjs` (new, repo root) holds the shared-connection-free CLI config: `client: "better-sqlite3"`, `connection: { filename: <placeholder> }`, `migrations: { directory: "./migrations", loadExtensions: [".ts"] }`. The CLI is only used for **scaffolding** (`migrate:make`); applying migrations is always the daemon/test `migrate()` API.

## Compatibility Notes

- knex `^3.3.0` minimum (first release shipping `connectionPool`).
- `useNullAsDefault: true` is mandatory for the SQLite dialect.
- Migration files must be erasable-syntax TypeScript (no enums/parameter properties) so they load identically under tsx today and native stripping later.
- `knex.raw` results for sqlite come back as arrays; use the provided generics or `knex.raw<T[]>` to type them.
