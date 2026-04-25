import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  claimPendingEvents,
  emitEvent,
  markEventFailed,
  EVENT_SCOPE_GLOBAL,
  type EventQueueRow,
} from "../../src/events/events-queue";
import { listDeadLetterEvents } from "../../src/events/dlq";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-dlq-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("DLQ listing", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("listDeadLetterEvents returns dead rows newest first", () => {
    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "x",
      payload: { a: 1 },
      maxAttempts: 1,
    });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    markEventFailed(db, row!.id, "poison");

    const listed = listDeadLetterEvents(db, { limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.eventType, "x");
    assert.equal(listed[0]!.lastError, "poison");
    assert.deepEqual(listed[0]!.payload, { a: 1 });
  });
});
