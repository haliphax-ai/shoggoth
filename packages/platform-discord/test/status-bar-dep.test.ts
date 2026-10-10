import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createSessionStore, defaultMigrationsDir, migrate } from "@shoggoth/daemon/lib";
import { DEFAULT_STATUS_BAR_CONFIG, type ResolvedStatusBarConfig } from "@shoggoth/shared";
import { buildStatusBarDep } from "../src/platform";

describe("buildStatusBarDep stats", () => {
  let tmp: string;
  let db: Database.Database;
  const cfg = { ...DEFAULT_STATUS_BAR_CONFIG } as ResolvedStatusBarConfig;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sb-dep-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    // session_stats.session_id has a FK to sessions — seed both sessions up front.
    const sessions = createSessionStore(db);
    sessions.create({ id: "s1", workspacePath: tmp });
    sessions.create({ id: "s2", workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns sequence/compactions from session_stats and context from the segment transcript estimate", () => {
    const dep = buildStatusBarDep(db, cfg);
    // Columns mirror what session-stats-store writes (incrementTurnCount /
    // recordCompaction / incrementTokenUsage). input_tokens is a cumulative
    // running sum and must NOT drive the bar's context fill.
    db.prepare(
      `INSERT INTO session_stats (session_id, turn_count, compaction_count, input_tokens,
              context_window_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("s1", 5, 2, 99_999, 128_000);
    // 128_000 chars ≈ 32_000 estimated tokens in the session's current segment.
    const segmentId = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content)
       VALUES (?, ?, 0, 'user', ?)`,
    ).run("s1", segmentId, "x".repeat(128_000));

    const stats = dep.stats("s1");
    expect(stats.sequence).toBe(5);
    expect(stats.compactions).toBe(2);
    expect(stats.context).toEqual({ currentTokens: 32_000, totalTokens: 128_000 });
  });

  it("omits context when the segment transcript is empty", () => {
    const dep = buildStatusBarDep(db, cfg);
    db.prepare(
      `INSERT INTO session_stats (session_id, turn_count, compaction_count, input_tokens, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run("s2", 3, 0, 0);

    const stats = dep.stats("s2");
    expect(stats.sequence).toBe(3);
    expect(stats.compactions).toBe(0);
    expect(stats.context).toBeUndefined();
  });

  it("defaults to zeroed stats for an unknown session", () => {
    const dep = buildStatusBarDep(db, cfg);
    const stats = dep.stats("missing");
    expect(stats.sequence).toBe(0);
    expect(stats.compactions).toBe(0);
    expect(stats.context).toBeUndefined();
  });
});
