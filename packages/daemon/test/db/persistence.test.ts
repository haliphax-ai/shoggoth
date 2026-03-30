import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { openStateDb, getJournalMode } from "../../src/db/open";
import { backupDatabaseToFile } from "../../src/db/backup";

const MIGRATION_FILE = /^(\d{4})_(.+)\.sql$/;

function migrationVersionsInDir(migrationsDir: string): number[] {
  const vs: number[] = [];
  for (const name of readdirSync(migrationsDir)) {
    const m = MIGRATION_FILE.exec(name);
    if (m) vs.push(Number.parseInt(m[1], 10));
  }
  vs.sort((a, b) => a - b);
  return vs;
}

describe(
  "persistence (migrations, WAL, backup)",
  { concurrency: false },
  () => {
  let dir: string;
  let dbPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-persist-"));
    dbPath = join(dir, "state.db");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies all numbered migrations forward-only and is idempotent", () => {
    const migrationsDir = defaultMigrationsDir();
    const expected = migrationVersionsInDir(migrationsDir);
    assert.ok(expected.length > 0, "migrations dir should contain .sql files");

    const db = openStateDb(dbPath);
    try {
      const first = migrate(db, migrationsDir);
      assert.deepStrictEqual([...first.appliedVersions], expected);
      const second = migrate(db, migrationsDir);
      assert.deepStrictEqual([...second.appliedVersions], []);
    } finally {
      db.close();
    }
  });

  it("creates initial schema tables (sessions, queue, audit, …)", () => {
    const db = openStateDb(dbPath);
    try {
      migrate(db, defaultMigrationsDir());
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));
      for (const need of [
        "_schema_migrations",
        "sessions",
        "transcript_messages",
        "events",
        "cron_jobs",
        "tool_runs",
        "event_processing_done",
        "audit_log",
        "operator_uid_map",
        "agent_tokens",
        "retention_metadata",
        "hitl_pending_actions",
        "hitl_session_tool_auto_approve",
        "memory_documents",
        "memory_fts",
        "memory_embeddings",
        "acpx_workspace_bindings",
      ]) {
        assert.ok(names.has(need), `missing table ${need}`);
      }
    } finally {
      db.close();
    }
  });

  it("repairs pre-subagent sessions table when 0001 was applied before subagent columns existed", () => {
    const legacy = join(dir, "legacy.db");
    const db = openStateDb(legacy);
    try {
      db.exec(`
        CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial');
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          agent_profile_id TEXT,
          model_selection_json TEXT,
          workspace_path TEXT NOT NULL,
          runtime_uid INTEGER,
          runtime_gid INTEGER,
          status TEXT NOT NULL,
          light_context INTEGER NOT NULL DEFAULT 0,
          prompt_stack_json TEXT NOT NULL DEFAULT '[]',
          context_segment_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE transcript_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
          context_segment_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_call_id TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (session_id, seq)
        );
      `);
      migrate(db, defaultMigrationsDir());
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('sessions') ORDER BY name")
        .all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      assert.ok(names.has("parent_session_id"));
      assert.ok(names.has("subagent_mode"));
      assert.ok(names.has("subagent_discord_thread_id"));
      assert.ok(names.has("subagent_expires_at_ms"));
    } finally {
      db.close();
    }
  });

  it("rejects duplicate migration versions in the same directory", () => {
    const badDir = join(dir, "bad-migrations");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(badDir, "0001_b.sql"), "SELECT 1;");
    const db = openStateDb(join(dir, "dup.db"));
    try {
      assert.throws(
        () => migrate(db, badDir),
        /Duplicate migration version 1/,
      );
    } finally {
      db.close();
    }
  });

  it("opens state DB in WAL mode", () => {
    const db = openStateDb(dbPath);
    try {
      assert.equal(getJournalMode(db), "wal");
    } finally {
      db.close();
    }
  });

  it("backupDatabaseToFile produces a consistent database file", async () => {
    const db = openStateDb(dbPath);
    const dest = join(dir, "snapshot.db");
    try {
      migrate(db, defaultMigrationsDir());
      await backupDatabaseToFile(db, dest);
    } finally {
      db.close();
    }
    const verify = openStateDb(dest);
    try {
      const row = verify.prepare("PRAGMA quick_check").get() as {
        quick_check: string;
      };
      assert.equal(row.quick_check, "ok");
    } finally {
      verify.close();
    }
  });
  },
);
