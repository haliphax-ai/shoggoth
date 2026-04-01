import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskList, TaskState, TaskDef, DependencyGraph } from "../src/types.js";
import { formatStatusMessage, formatSummaryMessage } from "../src/status-message.js";

// --- Helpers ---

function makeDef(id: number, prompt: string): TaskDef {
  return { id, prompt, failureBehavior: "continue", failureNotification: "silent" };
}

function makeTask(
  id: number,
  prompt: string,
  status: TaskState["status"],
  opts: Partial<Pick<TaskState, "startedAt" | "completedAt" | "error">> = {},
): TaskState {
  return { taskDef: makeDef(id, prompt), status, ...opts };
}

function makeWorkflow(
  name: string,
  tasks: TaskState[],
  graph: DependencyGraph,
): TaskList {
  return {
    id: "wf-1",
    name,
    tasks,
    graph,
    pollingIntervalMs: 10_000,
    createdAt: Date.now(),
  };
}

describe("formatStatusMessage", () => {
  it("formats a simple pending task with no deps", () => {
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("test-wf", [makeTask(1, "Do something", "pending")], graph);
    const msg = formatStatusMessage(wf);
    assert.ok(msg.includes("**Task workflow:** test-wf"));
    assert.ok(msg.includes("⏳ 1 - Do something"));
    // No duration for pending
    assert.ok(!msg.includes("("));
  });

  it("formats in-progress task with duration", () => {
    const now = Date.now();
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Running task", "in_progress", { startedAt: now - 20_000 }),
    ], graph);
    const msg = formatStatusMessage(wf, now);
    assert.ok(msg.includes("🚀 1 - Running task (20s)"));
  });

  it("formats completed task with duration", () => {
    const start = 1000;
    const end = 66_000; // 65s = 1m5s
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Done task", "done", { startedAt: start, completedAt: end }),
    ], graph);
    const msg = formatStatusMessage(wf);
    assert.ok(msg.includes("✅ 1 - Done task (1m5s)"));
  });

  it("formats failed task with duration", () => {
    const start = 1000;
    const end = 4_000; // 3s
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Bad task", "failed", { startedAt: start, completedAt: end }),
    ], graph);
    const msg = formatStatusMessage(wf);
    assert.ok(msg.includes("❌ 1 - Bad task (3s)"));
  });

  it("formats paused task with duration", () => {
    const now = Date.now();
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Paused task", "paused", { startedAt: now - 121_000 }),
    ], graph);
    const msg = formatStatusMessage(wf, now);
    assert.ok(msg.includes("⏸️ 1 - Paused task (2m1s)"));
  });

  it("shows dependencies in brackets", () => {
    const graph: DependencyGraph = new Map([
      [1, new Set()],
      [2, new Set([1])],
      [3, new Set([1, 2])],
    ]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "First", "done", { startedAt: 0, completedAt: 20_000 }),
      makeTask(2, "Second", "pending"),
      makeTask(3, "Third", "pending"),
    ], graph);
    const msg = formatStatusMessage(wf);
    assert.ok(msg.includes("✅ 1 - First (20s)"));
    assert.ok(msg.includes("⏳ 2 [1] - Second"));
    assert.ok(msg.includes("⏳ 3 [1,2] - Third"));
  });

  it("omits brackets when task has no dependencies", () => {
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [makeTask(1, "Solo", "pending")], graph);
    const msg = formatStatusMessage(wf);
    assert.ok(msg.includes("⏳ 1 - Solo"));
    assert.ok(!msg.includes("["));
  });

  it("formats a full multi-status workflow", () => {
    const now = Date.now();
    const graph: DependencyGraph = new Map([
      [1, new Set()],
      [2, new Set()],
      [3, new Set([2])],
      [4, new Set([3])],
      [5, new Set([1, 4])],
      [6, new Set()],
      [7, new Set([6])],
    ]);
    const wf = makeWorkflow("my-workflow", [
      makeTask(1, "Task one", "done", { startedAt: now - 40_000, completedAt: now - 20_000 }),
      makeTask(2, "Task two", "done", { startedAt: now - 125_000, completedAt: now - 60_000 }),
      makeTask(3, "Task three", "done", { startedAt: now - 57_000, completedAt: now - 20_000 }),
      makeTask(4, "Task four", "in_progress", { startedAt: now - 423_000 }),
      makeTask(5, "Task five", "pending"),
      makeTask(6, "Task six", "failed", { startedAt: now - 5_000, completedAt: now - 2_000 }),
      makeTask(7, "Task seven", "paused", { startedAt: now - 121_000 }),
    ], graph);
    const msg = formatStatusMessage(wf, now);

    assert.ok(msg.includes("**Task workflow:** my-workflow"));
    assert.ok(msg.includes("✅ 1 - Task one (20s)"));
    assert.ok(msg.includes("✅ 2 - Task two (1m5s)"));
    assert.ok(msg.includes("✅ 3 [2] - Task three (37s)"));
    assert.ok(msg.includes("🚀 4 [3] - Task four (7m3s)"));
    assert.ok(msg.includes("⏳ 5 [1,4] - Task five"));
    assert.ok(msg.includes("❌ 6 - Task six (3s)"));
    assert.ok(msg.includes("⏸️ 7 [6] - Task seven (2m1s)"));
  });
});

describe("formatSummaryMessage", () => {
  it("formats all-success summary without failed section", () => {
    const graph: DependencyGraph = new Map([
      [1, new Set()],
      [2, new Set([1])],
    ]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "A", "done", { startedAt: 0, completedAt: 60_000 }),
      makeTask(2, "B", "done", { startedAt: 60_000, completedAt: 120_000 }),
    ], graph);
    // Total duration = createdAt to last completedAt
    wf.createdAt = 0;
    const msg = formatSummaryMessage(wf);
    assert.ok(msg.includes("**Task workflow complete:** wf"));
    assert.ok(msg.includes("✅ **Completed:** 2/2"));
    assert.ok(!msg.includes("❌"));
  });

  it("formats summary with failed tasks listed", () => {
    const graph: DependencyGraph = new Map([
      [1, new Set()],
      [2, new Set()],
      [3, new Set()],
    ]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Good", "done", { startedAt: 0, completedAt: 60_000 }),
      makeTask(2, "Bad", "failed", { startedAt: 0, completedAt: 3_000, error: "oops" }),
      makeTask(3, "Also good", "done", { startedAt: 0, completedAt: 90_000 }),
    ], graph);
    wf.createdAt = 0;
    const msg = formatSummaryMessage(wf);
    assert.ok(msg.includes("**Task workflow complete:** wf"));
    assert.ok(msg.includes("✅ **Completed:** 2/3"));
    assert.ok(msg.includes("❌ **Failed:** 1/3"));
    assert.ok(msg.includes("- 2 - Bad (3s)"));
  });

  it("includes total duration from createdAt to last completedAt", () => {
    const graph: DependencyGraph = new Map([[1, new Set()]]);
    const wf = makeWorkflow("wf", [
      makeTask(1, "Task", "done", { startedAt: 5_000, completedAt: 1_278_000 }),
    ], graph);
    wf.createdAt = 0;
    const msg = formatSummaryMessage(wf);
    assert.ok(msg.includes("⏱️ **Duration:** 21m18s"));
  });
});
