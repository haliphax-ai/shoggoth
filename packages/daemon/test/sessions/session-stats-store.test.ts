import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/lib";
import {
  getSessionStats,
  recordCompaction,
  resetSegmentStats,
  incrementTurnCount,
  incrementTokenUsage,
} from "../../src/sessions/session-stats-store";

const TMP = join(import.meta.dirname ?? ".", ".tmp-session-stats-test");

function openTestDb(): Database.Database {
  mkdirSync(TMP, { recursive: true });
  const db = new Database(join(TMP, "test.db"));
  migrate(db, defaultMigrationsDir());
  // Seed a session row so FK constraint is satisfied
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, context_segment_id, workspace_path, status) VALUES (?, ?, ?, ?)",
  ).run("sess", "seg-1", "/tmp/test", "active");
  return db;
}

describe("session-stats-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    closeTestDb(db, TMP);
  });

  it("resetSegmentStats resets compaction_count to 0", () => {
    // Record some compactions
    recordCompaction(db, "sess", { transcriptMessageCount: 50 });
    recordCompaction(db, "sess", { transcriptMessageCount: 40 });
    const before = getSessionStats(db, "sess");
    assert.equal(before?.compactionCount, 2);
    assert.ok(before?.lastCompactedAt);

    // Reset
    resetSegmentStats(db, "sess");

    const after = getSessionStats(db, "sess");
    assert.equal(after?.compactionCount, 0, "compaction_count should be 0 after reset");
    assert.equal(after?.lastCompactedAt, null, "last_compacted_at should be null after reset");
  });

  it("resetSegmentStats resets turn_count and token counters", () => {
    incrementTurnCount(db, "sess");
    incrementTurnCount(db, "sess");
    incrementTokenUsage(db, "sess", { inputTokens: 100, outputTokens: 50 });

    const before = getSessionStats(db, "sess");
    assert.equal(before?.turnCount, 2);
    assert.equal(before?.inputTokens, 100);
    assert.equal(before?.outputTokens, 50);

    resetSegmentStats(db, "sess");

    const after = getSessionStats(db, "sess");
    assert.equal(after?.turnCount, 0);
    assert.equal(after?.inputTokens, 0);
    assert.equal(after?.outputTokens, 0);
    assert.equal(after?.transcriptMessageCount, 0);
  });
});
