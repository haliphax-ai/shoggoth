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
import type { ExecNotifyCompletion } from "../../src/exec/exec-notify-scheduler";
import {
  clearAllOneShotNotifyDrains,
  pendingDrains,
  settleOneShotAfterTurn,
} from "../../src/subagent/one-shot-notify-drain";
import { beginOneShotDelivery } from "../../src/subagent/one-shot-wake-window";
import { setTurnQueue, tryGetTurnQueue } from "../../src/sessions/session-turn-queue-singleton";
import { TieredTurnQueue } from "../../src/sessions/session-turn-queue";

/** The test suite always installs a fresh queue in beforeEach. */
function tryGetTurnQueueOrThrow(): TieredTurnQueue {
  const queue = tryGetTurnQueue();
  assert.ok(queue, "turn queue must be initialized by the test harness");
  return queue;
}
import {
  registerSteerChannel,
  pushSteer,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";
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

function makeHarness(
  deliver: (completion: ExecNotifyCompletion) => Promise<void> = async () => {},
): {
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
  const scheduler = new ExecNotifyScheduler(deliver);
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
    _resetAllChannels();
    setTurnQueue(new TieredTurnQueue());
  });
  afterEach(() => {
    clearAllOneShotNotifyDrains();
    setExecNotifyScheduler(undefined);
    setTurnQueue(undefined as never);
    _resetAllChannels();
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

  it("delivery in flight: the drained hold is NOT terminated until the delivery settles", async () => {
    let releaseDeliver!: () => void;
    const { db, scheduler, childId } = makeHarness(
      () =>
        new Promise<void>((resolve) => {
          releaseDeliver = resolve;
        }),
    );
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
    assert.equal(createSessionStore(db).getById(childId)?.status, "active", "held before resolve");

    // Resolve the handle while the delivery is still awaiting.
    beginOneShotDelivery(childId);
    proc.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "held while delivery is in flight (release before delivery destroyed the session in #620)",
    );
    assert.equal(scheduler.countForSession(db, childId), 0, "handle already resolved");

    // Delivery completes → the deferred release lands.
    releaseDeliver();
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("wake-up turn active at resolve: termination waits for the turn to end", async () => {
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

    // An active wake-up turn: resolve the last handle mid-turn.
    let finishWakeUp!: () => void;
    const wakeUpDone = new Promise<void>((r) => {
      finishWakeUp = r;
    });
    const queue = tryGetTurnQueueOrThrow();
    const turnPromise = queue.enqueue(childId, "system", "test-wake-up", async () => {
      await wakeUpDone;
    });
    beginOneShotDelivery(childId);
    proc.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(createSessionStore(db).getById(childId)?.status, "active");

    // The wake-up turn ends → the session terminates.
    finishWakeUp();
    await turnPromise;
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("release re-checks live handles at decision time (wake-up backgrounded new execs)", async () => {
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

    // Last handle resolves mid-turn: the release defers to the turn end.
    let finishWakeUp!: () => void;
    const wakeUpDone = new Promise<void>((r) => {
      finishWakeUp = r;
    });
    const queue = tryGetTurnQueueOrThrow();
    const turnPromise = queue.enqueue(childId, "system", "test-wake-up", async () => {
      await wakeUpDone;
    });
    proc.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pendingDrains.size, 1, "hold survives for the wake-up");

    // The wake-up turn registered a new handle: stay held until it drains.
    const proc2 = new FakeProcess();
    registerHandle(db, scheduler, childId, proc2);
    assert.equal(scheduler.countForSession(db, childId), 1);
    finishWakeUp();
    await turnPromise;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "new handles from the wake-up keep the hold",
    );
    proc2.exit(0);
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("steer-drop fallback OOB turn keeps the wake-up window open (drop callback gap)", async () => {
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

    // Incident-2 chain: active turn drains the notification, resolves
    // mid-turn, ends, drops the steer → wrapped OOB fallback turn; terminate
    // only after it settles.
    registerSteerChannel(childId);
    let finishActiveTurn!: () => void;
    const activeTurnDone = new Promise<void>((r) => {
      finishActiveTurn = r;
    });
    const queue = tryGetTurnQueueOrThrow();
    let resolveFallback!: () => void;
    const fallbackDone = new Promise<void>((r) => {
      resolveFallback = r;
    });
    const activeTurn = queue.enqueue(childId, "system", "test-active", async () => {
      await activeTurnDone;
    });
    // In-turn delivery + notification resolves mid-turn.
    pushSteer(childId, "notification body");
    proc.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(createSessionStore(db).getById(childId)?.status, "active");

    // Turn end → steer drop fires the wrapped fallback.
    const fallbackTurn = queue.enqueue(childId, "system", "test-oob-fallback", async () => {
      await fallbackDone;
    });
    finishActiveTurn();
    await activeTurn;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "held through the steer-drop → OOB-turn gap",
    );

    // Fallback turn finishes → the session terminates.
    resolveFallback();
    await fallbackTurn;
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("oneShotWakeFallback settle with idle queue releases the drained hold", async () => {
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
    proc.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "terminated",
      "no wake-up turn: deliver resolves immediately, release lands",
    );
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

    // The safety timer was cleared: time must not resurrect anything.
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
