import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { upsertCronJob, runCronTick } from "../../src/events/cron-scheduler";
import { EVENT_SCOPE_GLOBAL } from "../../src/events/events-queue";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-cr-"));
  const dbPath = join(dir, "c.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("cron scheduler", () => {
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

  it("runCronTick enqueues a durable event and advances next_run_at", () => {
    upsertCronJob(db, {
      id: "job1",
      scheduleExpr: "every:60s",
      payload: { hello: true },
    });
    db.prepare(`UPDATE cron_jobs SET next_run_at = datetime('now', '-1 second') WHERE id = 'job1'`).run();
    const fired = runCronTick(db);
    assert.equal(fired, 1);
    const ev = db
      .prepare(`SELECT event_type, payload_json FROM events WHERE scope = ? ORDER BY id DESC LIMIT 1`)
      .get(EVENT_SCOPE_GLOBAL) as { event_type: string; payload_json: string };
    assert.equal(ev.event_type, "cron.fire");
    const body = JSON.parse(ev.payload_json) as { cronJobId: string; payload: unknown };
    assert.equal(body.cronJobId, "job1");
    assert.deepEqual(body.payload, { hello: true });
    const job = db.prepare(`SELECT last_status, last_error FROM cron_jobs WHERE id = 'job1'`).get() as {
      last_status: string | null;
      last_error: string | null;
    };
    assert.equal(job.last_status, "ok");
    assert.equal(job.last_error, null);
  });

  it("records failure on cron tick when job definition is invalid", () => {
    upsertCronJob(db, { id: "bad", scheduleExpr: "not-a-schedule", payload: {} });
    db.prepare(`UPDATE cron_jobs SET next_run_at = datetime('now', '-1 second') WHERE id = 'bad'`).run();
    const fired = runCronTick(db);
    assert.equal(fired, 0);
    const job = db.prepare(`SELECT last_status, last_error FROM cron_jobs WHERE id = 'bad'`).get() as {
      last_status: string | null;
      last_error: string | null;
    };
    assert.equal(job.last_status, "error");
    assert.ok(job.last_error && job.last_error.length > 0);
  });
});
