import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { emitEvent, EVENT_SCOPE_GLOBAL } from "../../src/events/events-queue";
import {
  runHeartbeatBatch,
  createDefaultHeartbeatHandlers,
} from "../../src/events/heartbeat-consumer";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-hb-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("heartbeat consumer", () => {
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

  it("dispatches registered handler and completes event", async () => {
    let saw = 0;
    await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 2,
      handlers: {
        "custom.tick": () => {
          saw += 1;
        },
      },
    });
    assert.equal(saw, 0);

    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "custom.tick",
      payload: { n: 1 },
    });
    const n = await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 2,
      handlers: {
        "custom.tick": () => {
          saw += 1;
        },
      },
    });
    assert.equal(n, 1);
    assert.equal(saw, 1);
    const st = db.prepare("SELECT status FROM events WHERE event_type = 'custom.tick'").get() as {
      status: string;
    };
    assert.equal(st.status, "completed");
  });

  it("passes idempotencyKey to handler context via row", async () => {
    const keys: (string | null)[] = [];
    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "k",
      payload: {},
      idempotencyKey: "idem-1",
    });
    await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 1,
      handlers: {
        k: (row) => {
          keys.push(row.idempotencyKey);
        },
      },
    });
    assert.deepEqual(keys, ["idem-1"]);
  });

  it("unknown eventType uses markEventFailed until dead", async () => {
    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "unknown.kind",
      payload: {},
      maxAttempts: 2,
    });
    await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 2,
      handlers: {},
    });
    let row = db
      .prepare("SELECT status, attempts FROM events WHERE event_type = 'unknown.kind'")
      .get() as {
      status: string;
      attempts: number;
    };
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    db.prepare(
      `UPDATE events SET next_attempt_at = datetime('now', '-1 second') WHERE event_type = 'unknown.kind'`,
    ).run();
    await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 2,
      handlers: {},
    });
    row = db
      .prepare("SELECT status, attempts, last_error FROM events WHERE event_type = 'unknown.kind'")
      .get() as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    assert.equal(row.status, "dead");
    assert.equal(row.attempts, 2);
    assert.ok(String(row.last_error).includes("no_handler"));
  });

  it("createDefaultHeartbeatHandlers completes cron.fire", async () => {
    emitEvent(db, {
      scope: EVENT_SCOPE_GLOBAL,
      eventType: "cron.fire",
      payload: { cronJobId: "j", payload: {} },
    });
    const handlers = createDefaultHeartbeatHandlers({});
    const n = await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 2,
      handlers,
    });
    assert.equal(n, 1);
    const st = db.prepare("SELECT status FROM events WHERE event_type = 'cron.fire'").get() as {
      status: string;
    };
    assert.equal(st.status, "completed");
  });

  it("runs handlers with concurrency > 1", async () => {
    const done: number[] = [];
    for (let i = 0; i < 6; i++) {
      emitEvent(db, {
        scope: EVENT_SCOPE_GLOBAL,
        eventType: "parallel",
        payload: { i },
      });
    }
    await runHeartbeatBatch(db, {
      batchLimit: 10,
      concurrency: 3,
      handlers: {
        parallel: async (row) => {
          const p = row.payload as { i: number };
          await new Promise((r) => setTimeout(r, 5));
          done.push(p.i);
        },
      },
    });
    assert.equal(done.length, 6);
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE status != 'completed'")
      .get() as { c: number };
    assert.equal(pending.c, 0);
  });
});
