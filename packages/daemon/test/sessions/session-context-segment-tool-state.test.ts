import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { closeTestDb } from "../helpers/close-test-db";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../../src/sessions/session-context-segment";
import {
  getSessionToolState,
  setSessionToolState,
} from "../../src/sessions/session-tool-discovery";

describe("session context segment tool state", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;
  const sessionId = "sess-context-tool-state";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-session-tool-state-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: sessionId, workspacePath: tmp });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it.each([
    ["new", applySessionContextSegmentNew],
    ["reset", applySessionContextSegmentReset],
  ] as const)("%s clears the previous segment's tool state", (_operation, applySegment) => {
    const sessions = createSessionStore(db);
    setSessionToolState(db, sessionId, "builtin-exec", true);
    setSessionToolState(db, sessionId, "lsp-find_symbol", false);

    applySegment({ db, sessions, sessionId });

    assert.deepEqual(getSessionToolState(db, sessionId), new Map());
  });
});
