/**
 * Context segment transcript lifecycle: `new` abandons the old segment's rows behind a fresh
 * segment id; `reset` wipes the transcript in place and keeps the current segment.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { closeTestDb } from "../helpers/close-test-db";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../../src/sessions/session-context-segment";

function countSegmentRows(db: Database.Database, sessionId: string, segmentId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM transcript_messages WHERE session_id = ? AND context_segment_id = ?`,
      )
      .get(sessionId, segmentId) as { c: number }
  ).c;
}

describe("session context segment transcript handling", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;
  const SESSION_ID = "sess-segment-transcript";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-segment-transcript-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: SESSION_ID, workspacePath: tmp });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it("applySessionContextSegmentNew keeps the old rows but moves to a fresh segment", () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);
    const originalSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    transcript.append({
      sessionId: SESSION_ID,
      contextSegmentId: originalSegment,
      role: "user",
      content: "hello",
    });

    const out = applySessionContextSegmentNew({ db, sessions, sessionId: SESSION_ID });

    const newSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    assert.notEqual(newSegment, originalSegment, "new must mint a fresh segment id");
    assert.equal(out.contextSegmentId, newSegment);
    // Old rows are abandoned, not deleted — still present under the previous segment id.
    assert.equal(countSegmentRows(db, SESSION_ID, originalSegment), 1);
    assert.equal(countSegmentRows(db, SESSION_ID, newSegment), 0);
  });

  it("applySessionContextSegmentReset wipes the transcript and keeps the current segment", () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);
    const originalSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    transcript.append({
      sessionId: SESSION_ID,
      contextSegmentId: originalSegment,
      role: "user",
      content: "hello",
    });
    transcript.append({
      sessionId: SESSION_ID,
      contextSegmentId: originalSegment,
      role: "assistant",
      content: "hi",
    });

    const out = applySessionContextSegmentReset({ db, sessions, sessionId: SESSION_ID });

    const afterSegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    assert.equal(afterSegment, originalSegment, "reset must keep the current segment id");
    assert.equal(out.contextSegmentId, originalSegment);
    assert.equal(out.previousContextSegmentId, originalSegment);
    assert.equal(
      countSegmentRows(db, SESSION_ID, originalSegment),
      0,
      "transcript rows must be wiped, not abandoned",
    );
  });

  it("reset wipes only the target session's transcript", () => {
    const sessions = createSessionStore(db);
    const transcript = createTranscriptStore(db);
    sessions.create({ id: "other", workspacePath: tmp });
    const otherSegment = sessions.getById("other")!.contextSegmentId;
    transcript.append({
      sessionId: "other",
      contextSegmentId: otherSegment,
      role: "user",
      content: "keep me",
    });
    const mySegment = sessions.getById(SESSION_ID)!.contextSegmentId;
    transcript.append({
      sessionId: SESSION_ID,
      contextSegmentId: mySegment,
      role: "user",
      content: "wipe me",
    });

    applySessionContextSegmentReset({ db, sessions, sessionId: SESSION_ID });

    assert.equal(countSegmentRows(db, SESSION_ID, mySegment), 0);
    assert.equal(countSegmentRows(db, "other", otherSegment), 1, "other session must survive");
  });
});
