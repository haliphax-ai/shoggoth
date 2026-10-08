import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { closeTestDb } from "../helpers/close-test-db";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { TimerScheduler } from "../../src/timers/timer-scheduler";
import { createSessionStore } from "../../src/sessions/session-store";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import {
  register as registerTimer,
  setTimerScheduler,
} from "../../src/sessions/builtin-handlers/timer-handler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-timersched-"));
  const db = openStateDb(join(dir, "test.db"));
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function futureIso(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("TimerScheduler session anchoring", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it("persists sessionAnchor on schedule and returns it from listForSession", () => {
    const sched = new TimerScheduler(async () => {});
    sched.schedule(db, {
      id: "t1",
      sessionId: "sess-owner",
      label: "a",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "sess-anchor",
    });
    const rows = sched.listForSession(db, "sess-owner");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sessionAnchor, "sess-anchor");

    sched.schedule(db, {
      id: "t2",
      sessionId: "sess-owner",
      label: "b",
      fireAt: futureIso(),
      message: "m",
    });
    const rows2 = sched.listForSession(db, "sess-owner");
    const t2 = rows2.find((r) => r.id === "t2");
    assert.equal(t2!.sessionAnchor, null);
  });

  it("cancelByAnchorSession cancels only timers anchored to that session and returns the count", () => {
    const sched = new TimerScheduler(async () => {});
    sched.schedule(db, {
      id: "a1",
      sessionId: "owner",
      label: "a1",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-1",
    });
    sched.schedule(db, {
      id: "a2",
      sessionId: "owner",
      label: "a2",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-1",
    });
    sched.schedule(db, {
      id: "b1",
      sessionId: "owner",
      label: "b1",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-2",
    });
    sched.schedule(db, {
      id: "u1",
      sessionId: "owner",
      label: "u1",
      fireAt: futureIso(),
      message: "m",
    });

    const count = sched.cancelByAnchorSession("anchor-1");
    assert.equal(count, 2);

    const active = sched.listForSession(db, "owner");
    const activeIds = active.map((r) => r.id).sort();
    assert.deepEqual(activeIds, ["b1", "u1"]);
  });

  it("cancelByAnchorSession is idempotent — second call returns 0 and does not throw", () => {
    const sched = new TimerScheduler(async () => {});
    sched.schedule(db, {
      id: "x1",
      sessionId: "owner",
      label: "x1",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-x",
    });
    assert.equal(sched.cancelByAnchorSession("anchor-x"), 1);
    assert.equal(sched.cancelByAnchorSession("anchor-x"), 0);
    assert.equal(sched.cancelByAnchorSession("never-anchored"), 0);
  });

  it("anchor survives restore()", async () => {
    const a = new TimerScheduler(async () => {});
    a.schedule(db, {
      id: "r1",
      sessionId: "owner",
      label: "r1",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-r",
    });

    const b = new TimerScheduler(async () => {});
    await b.restore(db);
    const rows = b.listForSession(db, "owner");
    const r1 = rows.find((r) => r.id === "r1");
    assert.ok(r1, "timer should survive restore");
    assert.equal(r1!.sessionAnchor, "anchor-r");
  });

  it("flusSession carries sessionAnchor into the heap (cancel still works after flush)", () => {
    const sched = new TimerScheduler(async () => {});
    sched.schedule(db, {
      id: "f1",
      sessionId: "owner",
      label: "f1",
      fireAt: futureIso(),
      message: "m",
      sessionAnchor: "anchor-f",
    });
    sched.flushSession("owner");
    assert.equal(sched.cancelByAnchorSession("anchor-f"), 1);
    assert.equal(sched.listForSession(db, "owner").length, 0);
  });
});

describe("timer handler anchor_session validation", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    const sessions = createSessionStore(db);
    sessions.create({ id: "active-sess", workspacePath: "/w", status: "active" });
    sessions.create({ id: "terminated-sess", workspacePath: "/w", status: "terminated" });
    setTimerScheduler(new TimerScheduler(async () => {}));
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  function ctx(sessionId = "caller-sess"): BuiltinToolContext {
    return { sessionId, db } as unknown as BuiltinToolContext;
  }

  it("rejects anchor_session pointing at a nonexistent session", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const result = await reg.execute(
      "timer",
      { action: "set", label: "x", at: "10m", anchor_session: "no-such-session" },
      ctx(),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.ok(parsed.error);
    assert.match(parsed.error, /unknown session: no-such-session/);
  });

  it("rejects anchor_session pointing at a terminated session", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const result = await reg.execute(
      "timer",
      { action: "set", label: "x", at: "10m", anchor_session: "terminated-sess" },
      ctx(),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.ok(parsed.error);
    assert.match(parsed.error, /terminated/);
  });

  it("accepts anchor_session pointing at an active session and persists the anchor", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const result = await reg.execute(
      "timer",
      { action: "set", label: "x", at: "10m", anchor_session: "active-sess" },
      ctx(),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.ok, true);
    const row = db.prepare("SELECT session_anchor FROM timers WHERE id = ?").get(parsed.id) as {
      session_anchor: string | null;
    };
    assert.equal(row.session_anchor, "active-sess");
  });

  it("list surfaces sessionAnchor for anchored timers", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    await reg.execute(
      "timer",
      { action: "set", label: "x", at: "10m", anchor_session: "active-sess" },
      ctx("caller-sess"),
    );
    const list = await reg.execute("timer", { action: "list" }, ctx("caller-sess"));
    const parsed = JSON.parse(list.resultJson);
    assert.equal(parsed.timers.length, 1);
    assert.equal(parsed.timers[0].sessionAnchor, "active-sess");
  });
});
