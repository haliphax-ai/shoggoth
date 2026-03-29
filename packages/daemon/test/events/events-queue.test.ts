import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  claimPendingEvents,
  emitEvent,
  hasEventProcessingRecord,
  markEventCompleted,
  markEventFailed,
  reconcileStaleProcessing,
  EVENT_SCOPE_GLOBAL,
  sessionEventScope,
  type EventQueueRow,
} from "../../src/events/events-queue";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-ev-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("events queue", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emitEvent writes durable global and session-scoped rows", () => {
    const g = emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "notify",
      payload: { x: 1 },
    });
    assert.equal(g.ok, true);
    const s = emitEvent(db, {
      scope: sessionEventScope("s1"),
      eventType: "msg",
      payload: { t: "hi" },
    });
    assert.equal(s.ok, true);
    const rows = db.prepare("SELECT scope, event_type, status FROM events ORDER BY id").all() as {
      scope: string;
      event_type: string;
      status: string;
    }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.scope, EVENT_SCOPE_GLOBAL);
    assert.equal(rows[1]!.scope, "session:s1");
    assert.equal(rows[0]!.status, "pending");
  });

  it("dedupes emit by idempotency_key", () => {
    const a = emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "t",
      payload: {},
      idempotencyKey: "k1",
    });
    assert.equal(a.ok, true);
    const b = emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "t",
      payload: { other: true },
      idempotencyKey: "k1",
    });
    assert.equal(b.ok, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.existingId, a.id);
    const n = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    assert.equal(n.c, 1);
  });

  it("claimPendingEvents returns batch and moves rows to processing", () => {
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "a", payload: {} });
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "b", payload: {} });
    const batch = claimPendingEvents(db, { limit: 10 });
    assert.equal(batch.length, 2);
    const pending = db.prepare("SELECT COUNT(*) AS c FROM events WHERE status = 'pending'").get() as {
      c: number;
    };
    assert.equal(pending.c, 0);
    const proc = db.prepare("SELECT COUNT(*) AS c FROM events WHERE status = 'processing'").get() as {
      c: number;
    };
    assert.equal(proc.c, 2);
  });

  it("markEventCompleted closes out a claimed event", () => {
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "a", payload: {} });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    assert.equal(hasEventProcessingRecord(db, row!.id), false);
    markEventCompleted(db, row!.id);
    const st = db.prepare("SELECT status FROM events WHERE id = ?").get(row!.id) as { status: string };
    assert.equal(st.status, "completed");
    assert.equal(hasEventProcessingRecord(db, row!.id), true);
  });

  it("markEventFailed retries with backoff until DLQ (dead)", () => {
    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "a",
      payload: {},
      maxAttempts: 3,
    });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    const id = row!.id;
    markEventFailed(db, id, "e1");
    let r = db.prepare("SELECT status, attempts, next_attempt_at FROM events WHERE id = ?").get(id) as {
      status: string;
      attempts: number;
      next_attempt_at: string | null;
    };
    assert.equal(r.status, "pending");
    assert.equal(r.attempts, 1);
    assert.ok(r.next_attempt_at);
    claimPendingEvents(db, { limit: 10 });
    markEventFailed(db, id, "e2");
    r = db.prepare("SELECT status, attempts FROM events WHERE id = ?").get(id) as {
      status: string;
      attempts: number;
    };
    assert.equal(r.attempts, 2);
    claimPendingEvents(db, { limit: 10 });
    markEventFailed(db, id, "e3");
    r = db.prepare("SELECT status, attempts, last_error FROM events WHERE id = ?").get(id) as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    assert.equal(r.status, "dead");
    assert.equal(r.attempts, 3);
    assert.equal(r.last_error, "e3");
  });

  it("reconcileStaleProcessing returns pending rows stuck in processing", () => {
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "a", payload: {} });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    const past = new Date(Date.now() - 120_000).toISOString();
    db.prepare("UPDATE events SET claimed_at = ? WHERE id = ?").run(past, row!.id);
    const n = reconcileStaleProcessing(db, { staleMs: 60_000 });
    assert.equal(n, 1);
    const st = db.prepare("SELECT status, claimed_at FROM events WHERE id = ?").get(row!.id) as {
      status: string;
      claimed_at: string | null;
    };
    assert.equal(st.status, "pending");
    assert.equal(st.claimed_at, null);
  });

  it("respects next_attempt_at before claiming", () => {
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "a", payload: {} });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    markEventFailed(db, row!.id, "err");
    const empty = claimPendingEvents(db, { limit: 10 });
    assert.equal(empty.length, 0);
    db.prepare(
      `UPDATE events SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?`,
    ).run(row!.id);
    const again = claimPendingEvents(db, { limit: 10 });
    assert.equal(again.length, 1);
  });
});
