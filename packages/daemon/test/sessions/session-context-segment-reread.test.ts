/**
 * Integration tests for re-read list clearing on context segment new/reset.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../../src/sessions/session-context-segment";
import { checkReReadRequired } from "../../src/sessions/re-read-required";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-segment-reread-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function flag(db: Database.Database, sessionId: string, segmentId: string, filePath: string): void {
  db.prepare(
    "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
  ).run(sessionId, segmentId, filePath);
}

describe("session context segment re-read clearing", () => {
  let db: Database.Database;
  let tmp: string;
  const SESSION_ID = "sess-reread";

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: SESSION_ID, workspacePath: tmp });
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("applySessionContextSegmentNew clears re-read rows for the session", () => {
    const sessions = createSessionStore(db);
    const originalSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    flag(db, SESSION_ID, originalSegment, "/ws/a.ts");
    flag(db, SESSION_ID, originalSegment, "/ws/b.ts");

    applySessionContextSegmentNew({ db, sessions, sessionId: SESSION_ID });

    const newSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    assert.equal(checkReReadRequired(db, SESSION_ID, newSegment, "/ws/a.ts"), null);
    assert.equal(checkReReadRequired(db, SESSION_ID, newSegment, "/ws/b.ts"), null);
    assert.notEqual(newSegment, originalSegment, "segment id must change");
  });

  it("applySessionContextSegmentReset clears re-read rows for the session", () => {
    const sessions = createSessionStore(db);
    const originalSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    flag(db, SESSION_ID, originalSegment, "/ws/a.ts");

    applySessionContextSegmentReset({ db, sessions, sessionId: SESSION_ID });

    const newSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    assert.equal(checkReReadRequired(db, SESSION_ID, newSegment, "/ws/a.ts"), null);
  });

  it("only clears rows for the targeted session", () => {
    const sessions = createSessionStore(db);
    sessions.create({ id: "other", workspacePath: tmp });
    const mySegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    const otherSegment = sessions.getById("other")!.contextSegmentId;
    flag(db, SESSION_ID, mySegment, "/ws/mine.ts");
    flag(db, "other", otherSegment, "/ws/other.ts");

    applySessionContextSegmentNew({ db, sessions, sessionId: SESSION_ID });

    assert.equal(
      checkReReadRequired(db, SESSION_ID, mySegment, "/ws/mine.ts"),
      null,
      "this session's row must be cleared",
    );
    assert.ok(
      checkReReadRequired(db, "other", otherSegment, "/ws/other.ts"),
      "other session's row must survive",
    );
  });
});
