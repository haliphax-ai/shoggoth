# Shoggoth SQLite backup and restart

## Single-writer rule

Use **one** writing process for the state file (the daemon). Other tools (CLI maintenance commands) should run **sequentially** against the same path, or use a **hot backup** / read-only open of a snapshot—not concurrent writers.

## WAL mode

The daemon and CLI open the state DB with `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and `PRAGMA foreign_keys = ON` (see `openStateDb` in `packages/daemon/src/db/open.ts`). WAL improves crash safety and creates `-wal` / `-shm` sidecar files next to the main file.

## Files to back up

On disk you may see:

- `state.db` — main database
- `state.db-wal` — write-ahead log
- `state.db-shm` — shared memory index

For a **cold** backup (daemon stopped), copy all three if present, or copy only `state.db` after a clean shutdown that checkpointed WAL into the main file.

## Hot backup (daemon running)

1. **In-process (preferred):** `backupDatabaseToFile(db, '/path/to/backup.db')` uses SQLite’s online backup API (`better-sqlite3` `Database#backup`, exported from `@shoggoth/daemon/lib`).
2. **CLI:** `sqlite3 /path/to/state.db ".backup '/path/to/backup.db'"` (SQLite shell).

Restore by replacing `state.db` with the backup file (and removing stale `-wal`/`-shm` if you are not restoring them).

## Docker / volume

Mount a single volume for state (e.g. `/var/lib/shoggoth`). Back up that volume on your orchestrator’s schedule using snapshots or the hot-backup flow above.

## Migrations

Run `migrate(db, migrationsDir)` once at process startup before serving traffic. Migrations are **forward-only** (`NNNN_name.sql` under repo `migrations/`). Each step runs in an **IMMEDIATE** transaction and is recorded in `_schema_migrations`.
