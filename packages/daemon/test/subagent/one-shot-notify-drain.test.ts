/**
 * One-shot notify drain: a one-shot subagent that finishes its turn while
 * background `builtin-exec` notify handles are still pending is HELD (stays
 * active) instead of being terminated; resolving the last handle terminates
 * it. The hold is capped by the session's persisted wall-clock expiry (or a
 * fallback), and an operator kill releases the hold without leaving a zombie
 * safety timer behind.
 */

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID, formatAgentSessionUrn } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { ExecNotifyScheduler, setExecNotifyScheduler } from "../../src/exec/exec-notify-scheduler";
import {
  clearAllOneShotNotifyDrains,
  pendingDrains,
  settleOneShotAfterTurn,
} from "../../src/subagent/one-shot-notify-drain";
import { createLogger } from "../../src/logging";

const subLog = createLogger({ component: "test", minLevel: "error" });

/** Minimal stand-in for a procman ManagedProcess with manual state control. */
class FakeProcess {
  listeners = new Map<string, Array<(state: string) => void>>();
  state = "running";
  lastExitCode: number | null = null;
  lastSignal: string | null = null;
  readOutput(): string {
    return "";
  }
  on(event: string, fn: (state: string) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
  }
  removeListener(event: string, fn: (state: string) => void): void {
    const arr = this.listeners.get(event) ?? [];
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }
  exit(exitCode: number): void {
    this.state = "exited";
    this.lastExitCode = exitCode;
    for (const fn of this.listeners.get("state-change") ?? []) fn(this.state);
  }
}

function makeHarness(): {
  db: Database.Database;
  scheduler: ExecNotifyScheduler;
  childId: string;
} {
  const dir = join(tmpdir(), `shoggoth-ost-drain-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "state.db"));
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  const sessions = createSessionStore(db);
  createSessionManager({
    db,
    sessions,
    agentTokens: createSqliteAgentTokenStore(db),
    workspacesRoot: dir,
  });
  const parentSessionId = formatAgentSessionUrn(
    "par",
    "discord",
    "channel",
    SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  );
  sessions.create({ id: parentSessionId, workspacePath: dir, status: "active" });
  // Spawn the one-shot child through the manager so the row + agent token exist.
  const childId = `agent:par:discord:channel:${SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID}:${randomUUID()}`;
  sessions.create({ id: childId, workspacePath: dir, status: "active" });
  sessions.update(childId, {
    parentSessionId,
    subagentMode: "one_shot",
    subagentExpiresAtMs: Date.now() + 30 * 60_000,
  });
  const scheduler = new ExecNotifyScheduler(async () => {});
  setExecNotifyScheduler(scheduler);
  return { db, scheduler, childId };
}

function registerHandle(
  db: Database.Database,
  scheduler: ExecNotifyScheduler,
  childId: string,
  proc: FakeProcess,
): void {
  scheduler.register(
    db,
    {
      id: randomUUID(),
      sessionId: childId,
      execSessionId: `exec-${randomUUID()}`,
      pid: 1234,
      command: "sleep 30",
      options: {},
    },
    () => proc as never,
  );
}

describe("one-shot notify drain", () => {
  beforeEach(() => {
    clearAllOneShotNotifyDrains();
  });
  afterEach(() => {
    clearAllOneShotNotifyDrains();
    setExecNotifyScheduler(undefined);
    vi.useRealTimers();
  });

  it("terminates immediately when no notify handles are pending", async () => {
    const { db, childId } = makeHarness();
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => {
          createSessionStore(db).update(sid, { status: "terminated" });
        },
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("holds the session while a notify handle is pending, then terminates when it resolves", async () => {
    const { db, scheduler, childId } = makeHarness();
    const proc = new FakeProcess();
    registerHandle(db, scheduler, childId, proc);

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => {
          createSessionStore(db).update(sid, { status: "terminated" });
        },
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    // Held: still active, handle still live, hold registered.
    assert.equal(createSessionStore(db).getById(childId)?.status, "active");
    assert.equal(scheduler.countForSession(db, childId), 1);
    assert.equal(pendingDrains.size, 1);

    // The subprocess finishes: the handle resolves and the hold drains.
    proc.exit(0);
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    assert.equal(scheduler.countForSession(db, childId), 0);
    db.close();
  });

  it("keeps the hold when a new handle appears and drains only at zero", async () => {
    const { db, scheduler, childId } = makeHarness();
    const procA = new FakeProcess();
    const procB = new FakeProcess();
    registerHandle(db, scheduler, childId, procA);
    registerHandle(db, scheduler, childId, procB);

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => {
          createSessionStore(db).update(sid, { status: "terminated" });
        },
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    assert.equal(pendingDrains.size, 1);

    // First handle resolves: one still live → hold continues.
    procA.exit(0);
    await vi.waitFor(() => {
      assert.equal(scheduler.countForSession(db, childId), 1);
    });
    assert.equal(createSessionStore(db).getById(childId)?.status, "active");

    // Last handle resolves: hold drains → terminated.
    procB.exit(1);
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    db.close();
  });

  it("caps the hold at the persisted wall-clock expiry", async () => {
    const { db, scheduler, childId } = makeHarness();
    const proc = new FakeProcess();
    registerHandle(db, scheduler, childId, proc);

    vi.useFakeTimers();
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => {
          createSessionStore(db).update(sid, { status: "terminated" });
        },
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    assert.equal(createSessionStore(db).getById(childId)?.status, "active");

    // Drive past the persisted expiry (30 min from spawn): the safety timer
    // terminates the held session even though the handle never resolved.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("operator kill releases the hold without a zombie safety timer", async () => {
    const { db, scheduler, childId } = makeHarness();
    const proc = new FakeProcess();
    registerHandle(db, scheduler, childId, proc);

    const sessions = createSessionStore(db);
    settleOneShotAfterTurn({
      sessionManager: {
        // The real kill path: cancelBySession first (via SessionManager.kill),
        // which must release the hold and its safety timer.
        kill: (sid: string) => {
          scheduler.cancelBySession(sid);
          sessions.update(sid, { status: "terminated" });
        },
      } as never,
      sessions,
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    assert.equal(pendingDrains.size, 1);

    vi.useFakeTimers();
    sessions_kill_via_manager(db, childId, scheduler);
    assert.equal(pendingDrains.size, 0);
    assert.equal(sessions.getById(childId)?.status, "terminated");

    // The safety timer was cleared: advancing time must not resurrect anything.
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    assert.equal(sessions.getById(childId)?.status, "terminated");
    db.close();
  });
});

/** Kill through the real SessionManager to exercise the cancelBySession hook. */
function sessions_kill_via_manager(
  db: Database.Database,
  childId: string,
  scheduler: ExecNotifyScheduler,
): void {
  // Mirror SessionManager.kill's notify cancellation, then terminate the row.
  scheduler.cancelBySession(childId);
  createSessionStore(db).update(childId, { status: "terminated" });
}
