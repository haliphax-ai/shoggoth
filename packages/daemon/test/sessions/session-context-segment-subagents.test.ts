/**
 * Context segment new/reset must kill the session's still-running one-shot subagents while
 * leaving persistent subagents untouched (persistent subagents outlive the parent's context
 * lifecycle and are torn down only by TTL/inactivity or an explicit subagent kill).
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

const PARENT_ID = "sess-parent";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-segment-subagents-"));
  const db = openStateDb(join(dir, "test.db"));
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function makeChild(
  sessions: ReturnType<typeof createSessionStore>,
  id: string,
  dir: string,
  mode: "one_shot" | "persistent",
): void {
  sessions.create({ id, workspacePath: dir, status: "active" });
  sessions.update(id, { parentSessionId: PARENT_ID, subagentMode: mode });
}

describe("session context segment subagent kill", () => {
  let db: Database.Database;
  let tmp: string;
  let sessions: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    sessions = createSessionStore(db);
    sessions.create({ id: PARENT_ID, workspacePath: tmp, status: "active" });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it("applySessionContextSegmentNew kills one-shot subagents but not persistent ones", () => {
    makeChild(sessions, "child-one-shot", tmp, "one_shot");
    makeChild(sessions, "child-persistent", tmp, "persistent");

    const killed: string[][] = [];
    applySessionContextSegmentNew({
      db,
      sessions,
      sessionId: PARENT_ID,
      killSubagents: (ids) => killed.push(ids),
    });

    assert.deepEqual(killed, [["child-one-shot"]]);
  });

  it("applySessionContextSegmentReset kills one-shot subagents but not persistent ones", () => {
    makeChild(sessions, "child-one-shot", tmp, "one_shot");
    makeChild(sessions, "child-persistent", tmp, "persistent");

    const killed: string[][] = [];
    applySessionContextSegmentReset({
      db,
      sessions,
      sessionId: PARENT_ID,
      killSubagents: (ids) => killed.push(ids),
    });

    assert.deepEqual(killed, [["child-one-shot"]]);
  });

  it("does not invoke killSubagents when only persistent subagents are present", () => {
    makeChild(sessions, "child-persistent", tmp, "persistent");

    const killed: string[][] = [];
    applySessionContextSegmentReset({
      db,
      sessions,
      sessionId: PARENT_ID,
      killSubagents: (ids) => killed.push(ids),
    });

    assert.deepEqual(killed, []);
  });
});
