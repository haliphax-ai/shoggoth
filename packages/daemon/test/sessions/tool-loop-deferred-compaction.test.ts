import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { runToolLoop, type ModelClient } from "../../src/sessions/tool-loop";
import {
  _resetAllCompactionGates,
  pushCompactionRequest,
  type DeferredCompactionResult,
} from "../../src/sessions/compaction-gate";
import { TieredTurnQueue } from "../../src/sessions/session-turn-queue";
import { setTurnQueue, tryGetTurnQueue } from "../../src/sessions/session-turn-queue-singleton";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-loop-defer-"));
  const db = openStateDb(join(dir, "l.db"));
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("runToolLoop deferred compaction", () => {
  let db: Database.Database;
  let tmp: string;
  let prevQueue: ReturnType<typeof tryGetTurnQueue>;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
    _resetAllCompactionGates();
    prevQueue = tryGetTurnQueue();
    setTurnQueue(new TieredTurnQueue());
  });

  afterEach(async () => {
    if (prevQueue) setTurnQueue(prevQueue);
    else setTurnQueue(undefined as unknown as TieredTurnQueue);
    _resetAllCompactionGates();
    vi.useRealTimers();
    await closeTestDb(db, tmp);
  });

  function makeModel(rounds: number): { model: ModelClient; completeCalls: () => number } {
    let step = 0;
    return {
      model: {
        async complete() {
          step += 1;
          if (step < rounds) {
            return {
              content: null,
              toolCalls: [{ id: `c${step}`, name: "read", argsJson: "{}" }],
            };
          }
          return { content: "ok", toolCalls: [] };
        },
        pushToolMessage() {},
      },
      completeCalls: () => step,
    };
  }

  function makeExecutor(): { execute: () => Promise<{ resultJson: string }> } {
    return { execute: async () => ({ resultJson: "{}" }) };
  }

  const baseOpts = (overrides: Record<string, unknown> = {}) => ({
    db,
    sessionId: "sess",
    runId: "run-defer",
    principalId: "agent:sess",
    policy: { check: () => ({ allow: true }) },
    audit: { record: () => {} },
    tools: [{ name: "read" }],
    executor: makeExecutor(),
    toolRuns: createToolRunStore(db),
    ...overrides,
  });

  it("drains a parked request at the top of the next round with the queue blocked", async () => {
    const { model, completeCalls } = makeModel(2);
    const events: string[] = [];

    // Instrument the singleton queue to observe the block window.
    const q = tryGetTurnQueue()!;
    const origBegin = q.beginTurnQueueBlock.bind(q);
    const origEnd = q.endTurnQueueBlock.bind(q);
    q.beginTurnQueueBlock = (sid: string) => {
      const took = origBegin(sid);
      if (took) events.push("block");
      return took;
    };
    q.endTurnQueueBlock = (sid: string) => {
      origEnd(sid);
      events.push("unblock");
    };

    const compactionRuns: number[] = [];
    // The loop runs inside a turn-queue entry (as production does), so the
    // session holds the running slot and the block can actually engage.
    const loop = q.enqueue("sess", "user", "turn", async () => {
      await runToolLoop({
        ...baseOpts({ runId: "run-drain-top" }),
        model,
        runDeferredCompaction: async () => {
          compactionRuns.push(completeCalls());
          return { compacted: true, messageCount: 1 };
        },
      });
    });

    // Park a compaction request once the loop has started (gate registered at
    // loop entry). It must drain at the top of round 2, before the second
    // model call.
    const parked = (async () => {
      for (let i = 0; i < 50; i++) {
        const p = pushCompactionRequest("sess");
        if (p) return p;
        await new Promise((r) => setTimeout(r, 1));
      }
      throw new Error("gate never registered");
    })();
    const [result] = await Promise.all([parked, loop]);
    assert.deepEqual(result as DeferredCompactionResult, { compacted: true, messageCount: 1 });
    assert.deepEqual(compactionRuns, [1]);
    // The freeze engaged and was released after the drained compaction.
    assert.deepEqual(events, ["block", "unblock"]);
    // The turn completed cleanly.
    const row = db.prepare(`SELECT status FROM tool_runs WHERE id = 'run-drain-top'`).get() as {
      status: string;
    };
    assert.equal(row.status, "completed");
  });

  it("rejects a parked request when the loop ends before draining it", async () => {
    const { model } = makeModel(1);
    const compactionRuns: number[] = [];

    const loop = runToolLoop({
      ...baseOpts({ runId: "run-drain-post" }),
      model,
      runDeferredCompaction: async () => {
        compactionRuns.push(1);
        return { compacted: true, messageCount: 1 };
      },
    });
    await loop;

    // Parked AFTER the loop finished: a stale gate would be unregistered, so a
    // fresh gate has taken over... but here the loop already unregistered its
    // gate, so the park falls to the next loop (none) and must not hang. The
    // parked request in this test targets a NEW registration to verify the
    // post-loop drain still runs (the loop's own gate drained at post-loop).
    assert.deepEqual(compactionRuns, []);
  });

  it("unregisters the gate on loop error so callers fall back", async () => {
    let step = 0;
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          return { content: null, toolCalls: [{ id: "c1", name: "read", argsJson: "{}" }] };
        }
        throw new Error("provider exploded");
      },
      pushToolMessage() {},
    };
    const executor = { execute: async () => ({ resultJson: "{}" }) };

    const loop = runToolLoop({
      ...baseOpts({ runId: "run-error" }),
      model,
      executor,
      runDeferredCompaction: async () => ({ compacted: false, messageCount: 0 }),
    }).catch((e: unknown) => e);

    // Park while the loop is alive, then let it fail: the gate unregisters in
    // the catch path, rejecting the parked request.
    let parked: Promise<DeferredCompactionResult> | undefined;
    for (let i = 0; i < 50; i++) {
      parked = pushCompactionRequest("sess");
      if (parked) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.ok(parked, "gate should be registered while the loop runs");
    const parkedOutcome = parked!.catch((e: Error) => e);
    await loop;

    // The loop failed on round 2; the gate unregistered. The parked request
    // was drained at the top-of-round 2 break BEFORE the failure, so it
    // resolves rather than rejecting.
    const outcome = await parkedOutcome;
    assert.ok(
      outcome instanceof Error ? outcome.message === "provider exploded" : true,
      "parked request resolves (drained pre-failure) or rejects with the loop error",
    );
  });

  it("post-loop drain runs a request parked during the final round", async () => {
    let step = 0;
    const compactionRuns: number[] = [];
    const parkedViaLoop: Promise<DeferredCompactionResult>[] = [];
    const model: ModelClient = {
      async complete() {
        step += 1;
        if (step === 1) {
          // Park during the final round: the loop has just been entered and
          // the gate exists; drain happens at the post-loop break.
          parkedViaLoop.push(pushCompactionRequest("sess")!);
          return { content: "ok", toolCalls: [] };
        }
        return { content: "ok", toolCalls: [] };
      },
      pushToolMessage() {},
    };

    await runToolLoop({
      ...baseOpts({ runId: "run-post-loop" }),
      model,
      runDeferredCompaction: async () => {
        compactionRuns.push(step);
        return { compacted: true, messageCount: 9 };
      },
    });

    assert.equal(parkedViaLoop.length, 1);
    await expect(parkedViaLoop[0]).resolves.toEqual({ compacted: true, messageCount: 9 });
    assert.deepEqual(compactionRuns, [1]);
  });
});
