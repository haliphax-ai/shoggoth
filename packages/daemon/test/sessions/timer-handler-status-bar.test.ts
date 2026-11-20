import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import {
  register as registerTimer,
  setTimerScheduler,
} from "../../src/sessions/builtin-handlers/timer-handler";
import { TimerScheduler } from "../../src/timers/timer-scheduler";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

const SESSION_ID = "agent:test:discord:channel:123";

// The timer handler writes to the `timers` table through the scheduler, so the
// stub context needs a real migrated db. The same db backs `onTimersChanged`
// counts (`fired = 0` rows — queued and active timers as one cumulative sum),
// so set/cancel notifications reflect exactly what the status bar section shows.
function stubCtx(onTimersChanged?: BuiltinToolContext["onTimersChanged"]): {
  ctx: BuiltinToolContext;
  db: Database.Database;
} {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: SESSION_ID, workspacePath: "/tmp", status: "active" });
  setTimerScheduler(new TimerScheduler(async () => {}));
  return {
    db,
    ctx: {
      sessionId: SESSION_ID,
      db,
      config: {} as never,
      env: {},
      workspacePath: "/tmp",
      creds: { uid: 1000, gid: 1000 },
      orchestratorEnv: {},
      getAgentIntegrationInvoker: () => undefined,
      getProcessManager: () => undefined,
      messageToolCtx: undefined,
      memoryConfig: { paths: [], embeddings: { enabled: false } },
      runtimeOpenaiBaseUrl: undefined,
      isSubagentSession: false,
      ...(onTimersChanged ? { onTimersChanged } : {}),
    },
  };
}

describe("builtin-timer onTimersChanged (live status bar counts)", () => {
  it("notifies with the fresh cumulative count after a successful set", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const seen: number[] = [];
    const { ctx } = stubCtx((count) => seen.push(count));
    // Pre-existing active timer: the section already shows 1 at turn start.
    ctx.db
      .prepare(
        "INSERT INTO timers (id, session_id, label, fire_at, message) VALUES (?, ?, ?, ?, ?)",
      )
      .run("pre", SESSION_ID, "pre", "2030-01-01T00:00:00Z", "pre");
    await reg.execute("timer", { action: "set", label: "check-in", at: "5m" }, ctx);
    // A timer queued mid-turn counts toward the same cumulative sum as the
    // pre-existing active one — the live bar must see 2 in the SAME turn.
    assert.deepStrictEqual(seen, [2]);
  });

  it("notifies with the decreased count after a successful cancel", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const seen: number[] = [];
    const { ctx } = stubCtx((count) => seen.push(count));
    const setResult = await reg.execute(
      "timer",
      { action: "set", label: "check-in", at: "5m" },
      ctx,
    );
    assert.equal(JSON.parse(setResult.resultJson).ok, true);
    const id = JSON.parse(setResult.resultJson).id as string;
    await reg.execute("timer", { action: "cancel", id }, ctx);
    assert.deepStrictEqual(seen, [1, 0]);
  });

  it("does not notify for the list action", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const seen: number[] = [];
    const { ctx } = stubCtx((count) => seen.push(count));
    await reg.execute("timer", { action: "list" }, ctx);
    assert.deepStrictEqual(seen, []);
  });

  it("does not notify when set fails validation", async () => {
    const reg = new BuiltinToolRegistry();
    registerTimer(reg);
    const seen: number[] = [];
    const { ctx } = stubCtx((count) => seen.push(count));
    // Below the 2-minute minimum: the set is rejected, so nothing changed.
    const result = await reg.execute("timer", { action: "set", label: "x", at: "30s" }, ctx);
    assert.ok(JSON.parse(result.resultJson).error);
    assert.deepStrictEqual(seen, []);
  });
});
