import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, TaskList, TaskState, TaskStatus } from "../src/types.js";
import type { PollAdapter, PollResult } from "../src/orchestrator.js";
import { saveWorkflow, loadWorkflow } from "../src/state.js";
import { parseGraph } from "../src/graph.js";
import {
  isValidTransition,
  guardedTransition,
  createTickLock,
  detectOrphans,
  detectAndPersistOrphans,
} from "../src/hardening.js";

// --- Helpers ---

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-hardening-test-"));
}

function makeTask(id: number, prompt = `do task ${id}`): TaskDef {
  return {
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeTaskState(id: number, status: TaskStatus, extra?: Partial<TaskState>): TaskState {
  return {
    taskDef: makeTask(id),
    status,
    ...extra,
  };
}

function makeWorkflow(id: string, tasks: TaskState[], graphDsl: string): TaskList {
  return {
    id,
    name: `workflow-${id}`,
    tasks,
    graph: parseGraph(graphDsl),
    pollingIntervalMs: 50,
    createdAt: Date.now(),
  };
}

// --- Tests ---

describe("isValidTransition", () => {
  it("allows pending → in_progress", () => {
    assert.ok(isValidTransition("pending", "in_progress"));
  });

  it("allows pending → done", () => {
    assert.ok(isValidTransition("pending", "done"));
  });

  it("allows pending → failed", () => {
    assert.ok(isValidTransition("pending", "failed"));
  });

  it("allows in_progress → done", () => {
    assert.ok(isValidTransition("in_progress", "done"));
  });

  it("allows in_progress → failed", () => {
    assert.ok(isValidTransition("in_progress", "failed"));
  });

  it("rejects done → in_progress (backward)", () => {
    assert.ok(!isValidTransition("done", "in_progress"));
  });

  it("rejects done → pending (backward)", () => {
    assert.ok(!isValidTransition("done", "pending"));
  });

  it("rejects failed → in_progress (backward)", () => {
    assert.ok(!isValidTransition("failed", "in_progress"));
  });

  it("rejects failed → pending (backward)", () => {
    assert.ok(!isValidTransition("failed", "pending"));
  });

  it("rejects done → failed (terminal to terminal)", () => {
    assert.ok(!isValidTransition("done", "failed"));
  });

  it("rejects failed → done (terminal to terminal)", () => {
    assert.ok(!isValidTransition("failed", "done"));
  });

  it("rejects same-status transitions", () => {
    assert.ok(!isValidTransition("pending", "pending"));
    assert.ok(!isValidTransition("in_progress", "in_progress"));
    assert.ok(!isValidTransition("done", "done"));
    assert.ok(!isValidTransition("failed", "failed"));
  });

  it("allows paused → in_progress", () => {
    assert.ok(isValidTransition("paused", "in_progress"));
  });

  it("allows paused → done", () => {
    assert.ok(isValidTransition("paused", "done"));
  });
});

describe("guardedTransition", () => {
  it("applies valid transition and returns true", () => {
    const task = makeTaskState(1, "pending");
    const result = guardedTransition(task, "in_progress");
    assert.ok(result);
    assert.equal(task.status, "in_progress");
  });

  it("rejects invalid transition and returns false", () => {
    const task = makeTaskState(1, "done");
    const result = guardedTransition(task, "in_progress");
    assert.ok(!result);
    assert.equal(task.status, "done"); // unchanged
  });

  it("prevents done → pending regression", () => {
    const task = makeTaskState(1, "done");
    const result = guardedTransition(task, "pending");
    assert.ok(!result);
    assert.equal(task.status, "done");
  });

  it("prevents failed → pending regression", () => {
    const task = makeTaskState(1, "failed");
    const result = guardedTransition(task, "pending");
    assert.ok(!result);
    assert.equal(task.status, "failed");
  });
});

describe("createTickLock", () => {
  it("acquire returns true on first call", () => {
    const lock = createTickLock();
    assert.ok(lock.acquire());
  });

  it("acquire returns false when already locked", () => {
    const lock = createTickLock();
    lock.acquire();
    assert.ok(!lock.acquire());
  });

  it("release allows re-acquisition", () => {
    const lock = createTickLock();
    lock.acquire();
    lock.release();
    assert.ok(lock.acquire());
  });

  it("isLocked reflects current state", () => {
    const lock = createTickLock();
    assert.ok(!lock.isLocked());
    lock.acquire();
    assert.ok(lock.isLocked());
    lock.release();
    assert.ok(!lock.isLocked());
  });

  it("multiple release calls are safe", () => {
    const lock = createTickLock();
    lock.acquire();
    lock.release();
    lock.release(); // no-op
    assert.ok(!lock.isLocked());
  });
});

describe("detectOrphans", () => {
  it("marks tasks as failed when poll throws (session gone)", async () => {
    const wf = makeWorkflow("wf-orphan", [
      makeTaskState(1, "in_progress", { sessionKey: "dead-session", startedAt: 1000 }),
      makeTaskState(2, "pending"),
    ], "1>2");

    const poller: PollAdapter = {
      async poll(sessionKey: string): Promise<PollResult> {
        if (sessionKey === "dead-session") throw new Error("session not found");
        return { status: "running" };
      },
    };

    const result = await detectOrphans(wf, poller);
    assert.equal(result.orphanedCount, 1);
    assert.deepStrictEqual(result.orphanedTaskIds, [1]);

    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
    assert.ok(task1.error?.includes("orphaned"));
    assert.ok(task1.completedAt);
  });

  it("does not mark tasks when poll returns normally", async () => {
    const wf = makeWorkflow("wf-alive", [
      makeTaskState(1, "in_progress", { sessionKey: "alive-session", startedAt: 1000 }),
    ], "1");

    const poller: PollAdapter = {
      async poll(): Promise<PollResult> {
        return { status: "running" };
      },
    };

    const result = await detectOrphans(wf, poller);
    assert.equal(result.orphanedCount, 0);
    assert.equal(wf.tasks[0].status, "in_progress");
  });

  it("skips tasks that are not in_progress", async () => {
    const wf = makeWorkflow("wf-skip", [
      makeTaskState(1, "done", { output: "ok" }),
      makeTaskState(2, "pending"),
      makeTaskState(3, "failed", { error: "boom" }),
    ], "1>2>3");

    let pollCalled = false;
    const poller: PollAdapter = {
      async poll(): Promise<PollResult> {
        pollCalled = true;
        return { status: "running" };
      },
    };

    const result = await detectOrphans(wf, poller);
    assert.equal(result.orphanedCount, 0);
    assert.ok(!pollCalled, "poll should not be called for non-in_progress tasks");
  });

  it("handles multiple orphaned tasks", async () => {
    const wf = makeWorkflow("wf-multi-orphan", [
      makeTaskState(1, "in_progress", { sessionKey: "dead-1", startedAt: 1000 }),
      makeTaskState(2, "in_progress", { sessionKey: "dead-2", startedAt: 1000 }),
      makeTaskState(3, "in_progress", { sessionKey: "alive-3", startedAt: 1000 }),
    ], "1 2 3");

    const poller: PollAdapter = {
      async poll(sessionKey: string): Promise<PollResult> {
        if (sessionKey === "alive-3") return { status: "running" };
        throw new Error("session not found");
      },
    };

    const result = await detectOrphans(wf, poller);
    assert.equal(result.orphanedCount, 2);
    assert.deepStrictEqual(result.orphanedTaskIds.sort(), [1, 2]);
    assert.equal(wf.tasks[2].status, "in_progress"); // alive task unchanged
  });
});

describe("detectAndPersistOrphans", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("persists state when orphans are found", async () => {
    const wf = makeWorkflow("wf-persist-orphan", [
      makeTaskState(1, "in_progress", { sessionKey: "dead-session", startedAt: 1000 }),
    ], "1");
    saveWorkflow(baseDir, wf);

    const poller: PollAdapter = {
      async poll(): Promise<PollResult> {
        throw new Error("session not found");
      },
    };

    const result = await detectAndPersistOrphans(wf, poller, baseDir);
    assert.equal(result.orphanedCount, 1);

    // Verify persisted state
    const loaded = loadWorkflow(baseDir, "wf-persist-orphan")!;
    assert.equal(loaded.tasks[0].status, "failed");
    assert.ok(loaded.tasks[0].error?.includes("orphaned"));
  });

  it("does not persist when no orphans found", async () => {
    const wf = makeWorkflow("wf-no-orphan", [
      makeTaskState(1, "in_progress", { sessionKey: "alive", startedAt: 1000 }),
    ], "1");
    saveWorkflow(baseDir, wf);

    // Get the file's mtime before
    const statBefore = fs.statSync(path.join(baseDir, "wf-no-orphan.json"));

    const poller: PollAdapter = {
      async poll(): Promise<PollResult> {
        return { status: "running" };
      },
    };

    // Small delay to ensure mtime would differ if written
    await new Promise((r) => setTimeout(r, 50));

    const result = await detectAndPersistOrphans(wf, poller, baseDir);
    assert.equal(result.orphanedCount, 0);

    const statAfter = fs.statSync(path.join(baseDir, "wf-no-orphan.json"));
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "file should not be rewritten");
  });
});

describe("concurrent workflow isolation", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("state files for different workflows do not interfere", () => {
    const wf1 = makeWorkflow("wf-iso-1", [
      makeTaskState(1, "done", { output: "result-1" }),
    ], "1");
    const wf2 = makeWorkflow("wf-iso-2", [
      makeTaskState(1, "failed", { error: "boom" }),
    ], "1");

    saveWorkflow(baseDir, wf1);
    saveWorkflow(baseDir, wf2);

    const loaded1 = loadWorkflow(baseDir, "wf-iso-1")!;
    const loaded2 = loadWorkflow(baseDir, "wf-iso-2")!;

    assert.equal(loaded1.tasks[0].status, "done");
    assert.equal(loaded1.tasks[0].output, "result-1");
    assert.equal(loaded2.tasks[0].status, "failed");
    assert.equal(loaded2.tasks[0].error, "boom");
  });

  it("saving one workflow does not affect another", () => {
    const wf1 = makeWorkflow("wf-iso-a", [
      makeTaskState(1, "pending"),
    ], "1");
    const wf2 = makeWorkflow("wf-iso-b", [
      makeTaskState(1, "done", { output: "ok" }),
    ], "1");

    saveWorkflow(baseDir, wf1);
    saveWorkflow(baseDir, wf2);

    // Modify and re-save wf1
    wf1.tasks[0].status = "in_progress";
    wf1.tasks[0].sessionKey = "s-1";
    saveWorkflow(baseDir, wf1);

    // wf2 should be unchanged
    const loaded2 = loadWorkflow(baseDir, "wf-iso-b")!;
    assert.equal(loaded2.tasks[0].status, "done");
    assert.equal(loaded2.tasks[0].output, "ok");
  });
});
