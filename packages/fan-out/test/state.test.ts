import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveWorkflow,
  loadWorkflow,
  deleteWorkflow,
  listIncompleteWorkflows,
  type SerializedWorkflow,
} from "../src/state.js";
import type { TaskList, TaskState, TaskDef } from "../src/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-state-test-"));
}

function makeTaskDef(id: number, prompt = `task ${id}`): TaskDef {
  return {
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeTaskState(id: number, status: TaskState["status"] = "pending"): TaskState {
  return { taskDef: makeTaskDef(id), status };
}

function makeWorkflow(overrides: Partial<TaskList> = {}): TaskList {
  const graph = new Map<number, Set<number>>();
  graph.set(1, new Set());
  graph.set(2, new Set([1]));
  return {
    id: "wf-001",
    name: "test workflow",
    tasks: [makeTaskState(1), makeTaskState(2)],
    graph,
    pollingIntervalMs: 10_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("state persistence", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe("saveWorkflow / loadWorkflow", () => {
    it("round-trips a workflow through save and load", () => {
      const wf = makeWorkflow();
      saveWorkflow(baseDir, wf);
      const loaded = loadWorkflow(baseDir, wf.id);
      assert.ok(loaded);
      assert.equal(loaded.id, wf.id);
      assert.equal(loaded.name, wf.name);
      assert.equal(loaded.pollingIntervalMs, wf.pollingIntervalMs);
      assert.equal(loaded.tasks.length, 2);
      assert.equal(loaded.tasks[0].taskDef.id, 1);
      assert.equal(loaded.tasks[1].taskDef.id, 2);
    });

    it("preserves the dependency graph through serialization", () => {
      const wf = makeWorkflow();
      saveWorkflow(baseDir, wf);
      const loaded = loadWorkflow(baseDir, wf.id);
      assert.ok(loaded);
      assert.deepStrictEqual(loaded.graph.get(1), new Set());
      assert.deepStrictEqual(loaded.graph.get(2), new Set([1]));
    });

    it("preserves task statuses and outputs", () => {
      const wf = makeWorkflow();
      wf.tasks[0].status = "done";
      wf.tasks[0].output = "result from task 1";
      wf.tasks[0].startedAt = 1000;
      wf.tasks[0].completedAt = 2000;
      wf.tasks[1].status = "in_progress";
      wf.tasks[1].sessionKey = "session-abc";
      wf.tasks[1].startedAt = 2500;

      saveWorkflow(baseDir, wf);
      const loaded = loadWorkflow(baseDir, wf.id);
      assert.ok(loaded);
      assert.equal(loaded.tasks[0].status, "done");
      assert.equal(loaded.tasks[0].output, "result from task 1");
      assert.equal(loaded.tasks[0].startedAt, 1000);
      assert.equal(loaded.tasks[0].completedAt, 2000);
      assert.equal(loaded.tasks[1].status, "in_progress");
      assert.equal(loaded.tasks[1].sessionKey, "session-abc");
      assert.equal(loaded.tasks[1].startedAt, 2500);
    });

    it("overwrites existing state on re-save", () => {
      const wf = makeWorkflow();
      saveWorkflow(baseDir, wf);

      wf.tasks[0].status = "done";
      saveWorkflow(baseDir, wf);

      const loaded = loadWorkflow(baseDir, wf.id);
      assert.ok(loaded);
      assert.equal(loaded.tasks[0].status, "done");
    });

    it("creates the state directory if it does not exist", () => {
      const nested = path.join(baseDir, "deep", "nested");
      const wf = makeWorkflow();
      saveWorkflow(nested, wf);
      const loaded = loadWorkflow(nested, wf.id);
      assert.ok(loaded);
      assert.equal(loaded.id, wf.id);
    });
  });

  describe("loadWorkflow", () => {
    it("returns undefined for a non-existent workflow", () => {
      const loaded = loadWorkflow(baseDir, "does-not-exist");
      assert.equal(loaded, undefined);
    });
  });

  describe("deleteWorkflow", () => {
    it("removes a saved workflow", () => {
      const wf = makeWorkflow();
      saveWorkflow(baseDir, wf);
      deleteWorkflow(baseDir, wf.id);
      const loaded = loadWorkflow(baseDir, wf.id);
      assert.equal(loaded, undefined);
    });

    it("does not throw when deleting a non-existent workflow", () => {
      assert.doesNotThrow(() => deleteWorkflow(baseDir, "nope"));
    });
  });

  describe("listIncompleteWorkflows", () => {
    it("returns workflows that have non-terminal tasks", () => {
      const wf1 = makeWorkflow({ id: "wf-incomplete" });
      wf1.tasks[0].status = "done";
      wf1.tasks[1].status = "in_progress";
      saveWorkflow(baseDir, wf1);

      const wf2 = makeWorkflow({ id: "wf-complete" });
      wf2.tasks[0].status = "done";
      wf2.tasks[1].status = "done";
      saveWorkflow(baseDir, wf2);

      const incomplete = listIncompleteWorkflows(baseDir);
      assert.equal(incomplete.length, 1);
      assert.equal(incomplete[0].id, "wf-incomplete");
    });

    it("returns empty array when no state files exist", () => {
      const incomplete = listIncompleteWorkflows(baseDir);
      assert.deepStrictEqual(incomplete, []);
    });

    it("returns empty array when all workflows are complete", () => {
      const wf = makeWorkflow();
      wf.tasks[0].status = "done";
      wf.tasks[1].status = "failed";
      saveWorkflow(baseDir, wf);

      const incomplete = listIncompleteWorkflows(baseDir);
      assert.deepStrictEqual(incomplete, []);
    });
  });
});
