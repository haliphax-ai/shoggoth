import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { ManagedProcess } from "@shoggoth/procman";
import { closeTestDb } from "../helpers/close-test-db";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  ExecNotifyScheduler,
  type ExecNotifyCompletion,
  type ExecNotifyHandle,
} from "../../src/exec/exec-notify-scheduler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-execnotify-"));
  const db = openStateDb(join(dir, "test.db"));
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

/** Minimal stand-in for procman's ManagedProcess (EventEmitter + terminal API). */
function fakeProcess(
  state: string,
  out: { exitCode?: number | null; signal?: string | null; stdout?: string; stderr?: string } = {},
): ManagedProcess & EventEmitter {
  const mp = new EventEmitter() as unknown as ManagedProcess & EventEmitter;
  Object.assign(mp, {
    state,
    lastExitCode: out.exitCode ?? null,
    lastSignal: out.signal ?? null,
    readOutput: (stream: string) => (stream === "stdout" ? out.stdout : out.stderr) ?? "",
  });
  return mp;
}

function makeHandle(overrides: Partial<ExecNotifyHandle> = {}): ExecNotifyHandle {
  return {
    id: "n1",
    sessionId: "sess-1",
    execSessionId: "exec-1",
    pid: 4242,
    command: "sleep 5",
    options: {},
    ...overrides,
  };
}

describe("ExecNotifyScheduler", () => {
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

  it("persists a registered handle and counts it as live", () => {
    const sched = new ExecNotifyScheduler(async () => {});
    const mp = fakeProcess("running");
    sched.register(db, makeHandle(), () => mp);
    assert.equal(sched.countForSession(db, "sess-1"), 1);
    const rows = sched.listForSession(db, "sess-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "n1");
    assert.equal(rows[0]!.command, "sleep 5");
    assert.equal(rows[0]!.fired, false);
    sched.shutdown();
  });

  it("delivers a completion with exit code and output when the process terminates", async () => {
    const completions: ExecNotifyCompletion[] = [];
    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    const mp = fakeProcess("running");
    sched.register(db, makeHandle(), () => mp);
    Object.assign(mp, { state: "exited", lastExitCode: 3 });
    mp.emit("state-change", "exited");
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.exitCode, 3);
    // Count drops to zero once fired.
    assert.equal(sched.countForSession(db, "sess-1"), 0);
    sched.shutdown();
  });

  it("delivers immediately when the process is already terminal at registration", async () => {
    const completions: ExecNotifyCompletion[] = [];
    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    const mp = fakeProcess("exited", { exitCode: 0, stdout: "done" });
    sched.register(db, makeHandle(), () => mp);
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.exitCode, 0);
    assert.equal(completions[0]!.stdout, "done");
    sched.shutdown();
  });

  it("resolves as lost when the process is not tracked", async () => {
    const completions: ExecNotifyCompletion[] = [];
    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    sched.register(db, makeHandle(), () => undefined);
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.lost, true);
    assert.equal(completions[0]!.exitCode, null);
    sched.shutdown();
  });

  it("delivers only once for repeated terminal state-change events", async () => {
    let count = 0;
    const sched = new ExecNotifyScheduler(async () => {
      count += 1;
    });
    const mp = fakeProcess("running");
    sched.register(db, makeHandle(), () => mp);
    mp.emit("state-change", "exited");
    mp.emit("state-change", "dead");
    await new Promise((r) => setImmediate(r));
    assert.equal(count, 1);
    sched.shutdown();
  });

  it("cancel unsubscribes and prevents delivery", async () => {
    const completions: ExecNotifyCompletion[] = [];
    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    const mp = fakeProcess("running");
    sched.register(db, makeHandle(), () => mp);
    assert.equal(sched.cancel(db, "n1"), true);
    assert.equal(sched.cancel(db, "n1"), false);
    mp.emit("state-change", "exited");
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 0);
    assert.equal(sched.countForSession(db, "sess-1"), 0);
    sched.shutdown();
  });

  it("cancelBySession cancels only that session's live handles", () => {
    const sched = new ExecNotifyScheduler(async () => {});
    sched.register(db, makeHandle({ id: "a1" }), () => fakeProcess("running"));
    sched.register(db, makeHandle({ id: "a2" }), () => fakeProcess("running"));
    sched.register(
      db,
      makeHandle({ id: "b1", sessionId: "sess-2", execSessionId: "exec-b1" }),
      () => fakeProcess("running"),
    );
    assert.equal(sched.cancelBySession("sess-1"), 2);
    assert.equal(sched.countForSession(db, "sess-1"), 0);
    assert.equal(sched.countForSession(db, "sess-2"), 1);
    sched.shutdown();
  });

  it("restore resolves unfired handles as lost when the process is gone", async () => {
    const completions: ExecNotifyCompletion[] = [];
    const a = new ExecNotifyScheduler(async () => {});
    a.register(db, makeHandle(), () => fakeProcess("running"));
    a.shutdown();

    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    await sched.restore(db, () => undefined);
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.handle.id, "n1");
    assert.equal(completions[0]!.lost, true);
    assert.equal(sched.countForSession(db, "sess-1"), 0);
    sched.shutdown();
  });

  it("restore re-subscribes to a still-tracked live process", async () => {
    const a = new ExecNotifyScheduler(async () => {});
    a.register(db, makeHandle(), () => fakeProcess("running"));
    a.shutdown();

    const completions: ExecNotifyCompletion[] = [];
    const sched = new ExecNotifyScheduler(async (c) => {
      completions.push(c);
    });
    const mp = fakeProcess("running");
    await sched.restore(db, () => mp);
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 0);
    assert.equal(sched.countForSession(db, "sess-1"), 1);
    Object.assign(mp, { state: "exited", lastExitCode: 7 });
    mp.emit("state-change", "exited");
    await new Promise((r) => setImmediate(r));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.exitCode, 7);
    sched.shutdown();
  });

  it("survives a delivery failure without losing the fired marker", async () => {
    const sched = new ExecNotifyScheduler(async () => {
      throw new Error("surface offline");
    });
    const mp = fakeProcess("running");
    sched.register(db, makeHandle(), () => mp);
    mp.emit("state-change", "exited");
    await new Promise((r) => setImmediate(r));
    const row = db.prepare("SELECT fired FROM exec_notifies WHERE id = 'n1'").get() as {
      fired: number;
    };
    assert.equal(row.fired, 1);
    sched.shutdown();
  });
});
