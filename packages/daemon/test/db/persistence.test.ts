import { describe, it, beforeAll, afterAll } from "vitest";
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
  () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-persist-"));
    dbPath = join(dir, "state.db");
  });

  afterAll(() => {
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

  it("creates provider_failures table for model failover tracking", () => {
    const db = openStateDb(dbPath);
    try {
      migrate(db, defaultMigrationsDir());

      // Check table exists
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_failures'",
        )
        .get();
      assert.ok(tableExists, "provider_failures table should exist");

      // Check columns
      const columns = db
        .prepare("PRAGMA table_info(provider_failures)")
        .all() as { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];

      const colMap = new Map(columns.map((c) => [c.name, c]));

      // provider_id TEXT PRIMARY KEY
      const providerId = colMap.get("provider_id");
      assert.ok(providerId, "provider_id column should exist");
      assert.equal(providerId.type, "TEXT", "provider_id should be TEXT");
      assert.equal(providerId.pk, 1, "provider_id should be PRIMARY KEY");

      // failed_at TEXT
      const failedAt = colMap.get("failed_at");
      assert.ok(failedAt, "failed_at column should exist");
      assert.equal(failedAt.type, "TEXT", "failed_at should be TEXT");

      // error TEXT
      const error = colMap.get("error");
      assert.ok(error, "error column should exist");
      assert.equal(error.type, "TEXT", "error should be TEXT");

      // retry_count INTEGER DEFAULT 0
      const retryCount = colMap.get("retry_count");
      assert.ok(retryCount, "retry_count column should exist");
      assert.equal(retryCount.type, "INTEGER", "retry_count should be INTEGER");
      assert.equal(retryCount.dflt_value, "0", "retry_count should have DEFAULT 0");
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