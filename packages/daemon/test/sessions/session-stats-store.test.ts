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
  getContextFill,
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

  afterEach(async () => {
    await closeTestDb(db, TMP);
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

describe("session-stats-store provider usage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db, TMP);
  });

  it("accumulates the provider cache split and sets the context-fill gauge", () => {
    incrementTokenUsage(db, "sess", {
      inputTokens: 2000,
      outputTokens: 300,
      cachedInputTokens: 1500,
      cacheWriteInputTokens: 200,
      contextFillTokens: 2300,
    });
    incrementTokenUsage(db, "sess", {
      inputTokens: 2500,
      outputTokens: 100,
      cachedInputTokens: 2000,
      contextFillTokens: 2600,
    });

    const stats = getSessionStats(db, "sess");
    assert.equal(stats?.inputTokens, 4500);
    assert.equal(stats?.outputTokens, 400);
    assert.equal(stats?.cachedInputTokens, 3500);
    assert.equal(stats?.cacheWriteInputTokens, 200);
    assert.equal(stats?.contextFillTokens, 2600, "gauge takes the last call's value");
  });

  it("leaves the gauge untouched when contextFillTokens is not provided", () => {
    incrementTokenUsage(db, "sess", { inputTokens: 100, outputTokens: 50, contextFillTokens: 150 });
    // heuristic-only increment (e.g. tool-output estimate) must not move the gauge
    incrementTokenUsage(db, "sess", { inputTokens: 40, outputTokens: 0 });

    const stats = getSessionStats(db, "sess");
    assert.equal(stats?.inputTokens, 140);
    assert.equal(stats?.contextFillTokens, 150);
  });

  it("getContextFill prefers the provider gauge over the transcript heuristic", () => {
    db.prepare(
      "INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run("sess", "seg-1", 1, "user", "12345678"); // 2 tokens by heuristic

    incrementTokenUsage(db, "sess", {
      inputTokens: 900,
      outputTokens: 100,
      contextFillTokens: 1000,
    });

    assert.equal(getContextFill(db, "sess", "seg-1"), 1000);
  });

  it("getContextFill falls back to the transcript heuristic without provider usage", () => {
    db.prepare(
      "INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)",
    ).run("sess", "seg-1", 1, "user", "12345678");

    assert.equal(getContextFill(db, "sess", "seg-1"), 2);
  });

  it("resetSegmentStats clears the cache counters and gauge", () => {
    incrementTokenUsage(db, "sess", {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 10,
      contextFillTokens: 150,
    });

    resetSegmentStats(db, "sess");

    const stats = getSessionStats(db, "sess");
    assert.equal(stats?.cachedInputTokens, 0);
    assert.equal(stats?.cacheWriteInputTokens, 0);
    assert.equal(stats?.contextFillTokens, null);
  });

  it("recordCompaction clears the stale gauge", () => {
    incrementTokenUsage(db, "sess", {
      inputTokens: 100,
      outputTokens: 50,
      contextFillTokens: 150,
    });

    recordCompaction(db, "sess", { transcriptMessageCount: 20 });

    const stats = getSessionStats(db, "sess");
    assert.equal(stats?.compactionCount, 1);
    assert.equal(stats?.contextFillTokens, null, "gauge is stale after compaction");
    assert.equal(stats?.inputTokens, 100, "cumulative totals untouched by compaction");
  });
});
