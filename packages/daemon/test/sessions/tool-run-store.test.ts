import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-trun-"));
  const dbPath = join(dir, "r.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("ToolRunStore", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "s", workspacePath: "/w" });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("markAllRunningFailed sets failure_reason", () => {
    const tr = createToolRunStore(db);
    tr.insertRunning({ id: "run-1", sessionId: "s" });
    const n = tr.markAllRunningFailed("shutdown:sigterm");
    assert.equal(n, 1);
    const row = db
      .prepare(`SELECT status, failure_reason FROM tool_runs WHERE id = 'run-1'`)
      .get() as { status: string; failure_reason: string | null };
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "shutdown:sigterm");
  });
});
