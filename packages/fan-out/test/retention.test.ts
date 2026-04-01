import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, TaskList } from "../src/types.js";
import { saveWorkflow, loadWorkflow, listAllWorkflows } from "../src/state.js";
import { parseGraph } from "../src/graph.js";
import {
  retentionRun,
  startRetentionSchedule,
  stopRetentionSchedule,
  COMPLETED_MAX_AGE_MS,
  PAUSED_MAX_AGE_MS,
} from "../src/retention.js";

// --- Helpers ---

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-retention-test-"));
}

function makeTask(id: number, prompt = `do task ${id}`): TaskDef {
  return {
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeWorkflow(id: string, overrides?: Partial<TaskList>): TaskList {
  return {
    id,
    name: `workflow-${id}`,
    tasks: [
      { taskDef: makeTask(1), status: "done", output: "ok", startedAt: 1000, completedAt: 2000 },
    ],
    graph: parseGraph("1"),
    pollingIntervalMs: 50,
    createdAt: 1000,
    ...overrides,
  };
}

// --- Tests ---

describe("listAllWorkflows", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("returns all workflows including completed ones", () => {
    const wf1 = makeWorkflow("wf-1");
    const wf2 = makeWorkflow("wf-2", {
      tasks: [{ taskDef: makeTask(1), status: "in_progress", sessionKey: "s-1", startedAt: 1000 }],
    });
    saveWorkflow(baseDir, wf1);
    saveWorkflow(baseDir, wf2);

    const all = listAllWorkflows(baseDir);
    assert.equal(all.length, 2);
    const ids = all.map((w) => w.id).sort();
    assert.deepStrictEqual(ids, ["wf-1", "wf-2"]);
  });

  it("returns empty array for nonexistent directory", () => {
    const result = listAllWorkflows("/tmp/nonexistent-dir-xyz");
    assert.deepStrictEqual(result, []);
  });

  it("skips corrupt files", () => {
    saveWorkflow(baseDir, makeWorkflow("wf-good"));
    fs.writeFileSync(path.join(baseDir, "wf-bad.json"), "not json{{{", "utf-8");

    const all = listAllWorkflows(baseDir);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "wf-good");
  });
});

describe("retentionRun", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("prunes completed workflows older than 48 hours", () => {
    const now = Date.now();
    const oldCompletedAt = now - COMPLETED_MAX_AGE_MS - 1_000;

    const wf = makeWorkflow("wf-old-done", {
      createdAt: oldCompletedAt - 10_000,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: oldCompletedAt - 5_000, completedAt: oldCompletedAt },
      ],
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 1);
    assert.deepStrictEqual(result.prunedIds, ["wf-old-done"]);
    assert.equal(loadWorkflow(baseDir, "wf-old-done"), undefined);
  });

  it("does not prune completed workflows younger than 48 hours", () => {
    const now = Date.now();
    const recentCompletedAt = now - COMPLETED_MAX_AGE_MS + 60_000;

    const wf = makeWorkflow("wf-recent-done", {
      createdAt: recentCompletedAt - 10_000,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: recentCompletedAt - 5_000, completedAt: recentCompletedAt },
      ],
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 0);
    assert.ok(loadWorkflow(baseDir, "wf-recent-done"));
  });

  it("prunes failed (terminal) workflows older than 48 hours", () => {
    const now = Date.now();
    const oldCompletedAt = now - COMPLETED_MAX_AGE_MS - 1_000;

    const wf = makeWorkflow("wf-old-failed", {
      createdAt: oldCompletedAt - 10_000,
      tasks: [
        { taskDef: makeTask(1), status: "failed", error: "boom", startedAt: oldCompletedAt - 5_000, completedAt: oldCompletedAt },
      ],
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 1);
    assert.deepStrictEqual(result.prunedIds, ["wf-old-failed"]);
  });

  it("prunes paused workflows older than 7 days", () => {
    const now = Date.now();
    const oldCreatedAt = now - PAUSED_MAX_AGE_MS - 1_000;

    const wf = makeWorkflow("wf-old-paused", {
      createdAt: oldCreatedAt,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: oldCreatedAt + 1_000, completedAt: oldCreatedAt + 2_000 },
        { taskDef: makeTask(2), status: "pending" },
      ],
      graph: parseGraph("1>2"),
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 1);
    assert.deepStrictEqual(result.prunedIds, ["wf-old-paused"]);
  });

  it("does not prune paused workflows younger than 7 days", () => {
    const now = Date.now();
    const recentCreatedAt = now - PAUSED_MAX_AGE_MS + 60_000;

    const wf = makeWorkflow("wf-recent-paused", {
      createdAt: recentCreatedAt,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: recentCreatedAt + 1_000, completedAt: recentCreatedAt + 2_000 },
        { taskDef: makeTask(2), status: "pending" },
      ],
      graph: parseGraph("1>2"),
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 0);
    assert.ok(loadWorkflow(baseDir, "wf-recent-paused"));
  });

  it("does not prune in-progress workflows", () => {
    const now = Date.now();
    const oldCreatedAt = now - PAUSED_MAX_AGE_MS - 1_000;

    const wf = makeWorkflow("wf-in-progress", {
      createdAt: oldCreatedAt,
      tasks: [
        { taskDef: makeTask(1), status: "in_progress", sessionKey: "s-1", startedAt: oldCreatedAt + 1_000 },
        { taskDef: makeTask(2), status: "pending" },
      ],
      graph: parseGraph("1>2"),
    });
    saveWorkflow(baseDir, wf);

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 0);
  });

  it("prunes multiple workflows in one run", () => {
    const now = Date.now();
    const oldTime = now - COMPLETED_MAX_AGE_MS - 1_000;

    for (let i = 1; i <= 3; i++) {
      saveWorkflow(baseDir, makeWorkflow(`wf-old-${i}`, {
        createdAt: oldTime - 10_000,
        tasks: [
          { taskDef: makeTask(1), status: "done", output: "ok", startedAt: oldTime - 5_000, completedAt: oldTime },
        ],
      }));
    }

    // One recent workflow that should survive
    saveWorkflow(baseDir, makeWorkflow("wf-recent", {
      createdAt: now - 1_000,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: now - 500, completedAt: now },
      ],
    }));

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 3);
    assert.ok(loadWorkflow(baseDir, "wf-recent"));
  });

  it("returns empty summary when nothing to prune", () => {
    const result = retentionRun(baseDir);
    assert.equal(result.pruned, 0);
    assert.deepStrictEqual(result.prunedIds, []);
  });

  it("respects custom maxAge options", () => {
    const now = Date.now();
    const completedAt = now - 10_000; // 10 seconds ago

    saveWorkflow(baseDir, makeWorkflow("wf-custom", {
      createdAt: completedAt - 5_000,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: completedAt - 2_000, completedAt },
      ],
    }));

    // With default thresholds, 10s old workflow should NOT be pruned
    const result1 = retentionRun(baseDir, { now });
    assert.equal(result1.pruned, 0);

    // With custom threshold of 5s, it SHOULD be pruned
    const result2 = retentionRun(baseDir, { now, completedMaxAgeMs: 5_000 });
    assert.equal(result2.pruned, 1);
  });

  it("uses createdAt as fallback when no completedAt timestamps exist", () => {
    const now = Date.now();
    const oldCreatedAt = now - COMPLETED_MAX_AGE_MS - 1_000;

    saveWorkflow(baseDir, makeWorkflow("wf-no-timestamps", {
      createdAt: oldCreatedAt,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok" },
      ],
    }));

    const result = retentionRun(baseDir, { now });
    assert.equal(result.pruned, 1);
  });
});

describe("retention schedule", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => {
    stopRetentionSchedule();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("startRetentionSchedule runs retention periodically", async () => {
    const now = Date.now();
    const oldTime = now - COMPLETED_MAX_AGE_MS - 1_000;

    saveWorkflow(baseDir, makeWorkflow("wf-scheduled", {
      createdAt: oldTime - 10_000,
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: oldTime - 5_000, completedAt: oldTime },
      ],
    }));

    startRetentionSchedule(baseDir, 50);

    // Wait for at least one interval
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(loadWorkflow(baseDir, "wf-scheduled"), undefined);
  });

  it("stopRetentionSchedule stops the timer", () => {
    startRetentionSchedule(baseDir, 50);
    stopRetentionSchedule();
    // No assertion needed — just verifying it doesn't throw
  });

  it("startRetentionSchedule replaces previous schedule", () => {
    startRetentionSchedule(baseDir, 50);
    startRetentionSchedule(baseDir, 100);
    stopRetentionSchedule();
    // No assertion needed — just verifying no double timers
  });
});
