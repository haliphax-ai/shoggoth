import { describe, it } from "vitest";
import assert from "node:assert/strict";

/**
 * Tests for the duration field in workflow status output.
 *
 * The duration field is computed in tool-handler.ts when handling the "status" action:
 * - For tasks that have started: duration = (completedAt ?? now) - startedAt
 * - For pending tasks (no startedAt): duration is omitted
 */

import { handleWorkflowToolCall, type WorkflowToolHandlerDeps } from "../src/tool-handler.js";
import type { WorkflowServer } from "../src/server.js";
import type { ControlPlane } from "../src/control.js";
import type { TaskList, TaskState, DependencyGraph } from "../src/types.js";

// --- Mocks ---

function mockServer(overrides: Partial<WorkflowServer> = {}): WorkflowServer {
  return {
    start: async () => "wf-123",
    resume: async () => [],
    get: () => undefined,
    getOrchestrators: () => new Map(),
    stopAll: async () => {},
    ...overrides,
  } as unknown as WorkflowServer;
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskDef: {
      kind: "agent" as const,
      id: 1,
      prompt: "test task",
      failureBehavior: "continue" as const,
      failureNotification: "silent" as const,
    },
    status: "pending" as const,
    ...overrides,
  };
}

function makeWorkflow(tasks: TaskState[], overrides: Partial<TaskList> = {}): TaskList {
  const graph: DependencyGraph = new Map();
  for (const task of tasks) {
    graph.set(task.taskDef.id, new Set<number>());
  }

  return {
    id: "wf-test",
    name: "test-workflow",
    tasks,
    graph,
    pollingIntervalMs: 10000,
    createdAt: 1000,
    ...overrides,
  };
}

function mockControlPlane(workflow: TaskList): ControlPlane {
  return {
    abort: async () => {},
    pause: async () => {},
    resume: async () => {},
    status: async () => workflow,
    list: async () => [],
    post: async () => {},
    edit: async () => {},
    retry: async () => {},
    retention: async () => ({ prunedIds: [], prunedCount: 0 }),
  } as unknown as ControlPlane;
}

function makeDeps(workflow: TaskList): WorkflowToolHandlerDeps {
  return {
    server: mockServer(),
    controlPlane: mockControlPlane(workflow),
    stateDir: "/tmp/workflow-test",
    currentDepth: 0,
    maxDepth: 2,
  };
}

// --- Duration tests ---

describe("duration field in workflow status", () => {
  it("calculates duration correctly for completed tasks (completedAt - startedAt)", async () => {
    // Task completed at 2000, started at 1000 -> duration = 1000ms
    const task = makeTask({
      status: "done",
      startedAt: 1000,
      completedAt: 2000,
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    assert.equal(data.tasks[0].duration, 1000);
  });

  it("calculates duration correctly for in-progress tasks (now - startedAt)", async () => {
    // Simulate an in-progress task by using a known "now" value
    // The implementation uses Date.now(), so we test that duration is a positive number
    const startedAt = Date.now() - 5000; // Started 5 seconds ago
    const task = makeTask({
      status: "in_progress",
      startedAt,
      // no completedAt - still running
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // Duration should be approximately 5000ms (allow some tolerance)
    assert.ok(data.tasks[0].duration! >= 4900 && data.tasks[0].duration! <= 5100);
  });

  it("omits duration for pending tasks that haven't started", async () => {
    const task = makeTask({
      status: "pending",
      // no startedAt
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // duration should be undefined for pending tasks
    assert.equal(data.tasks[0].duration, undefined);
  });

  it("includes duration for all tasks that have started", async () => {
    const tasks = [
      makeTask({
        taskDef: {
          kind: "agent",
          id: 1,
          prompt: "task 1",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        status: "done",
        startedAt: 1000,
        completedAt: 2000,
      }),
      makeTask({
        taskDef: {
          kind: "agent",
          id: 2,
          prompt: "task 2",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        status: "in_progress",
        startedAt: 2000,
      }),
      makeTask({
        taskDef: {
          kind: "agent",
          id: 3,
          prompt: "task 3",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        status: "pending",
      }),
    ];
    const wf = makeWorkflow(tasks);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // Task 1 (done) should have duration
    assert.equal(data.tasks[0].duration, 1000);
    // Task 2 (in_progress) should have duration
    assert.ok(data.tasks[1].duration! > 0);
    // Task 3 (pending) should NOT have duration
    assert.equal(data.tasks[2].duration, undefined);
  });

  it("handles task with no startedAt field at all", async () => {
    const task = makeTask({
      status: "pending",
      // startedAt is explicitly undefined
      startedAt: undefined,
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    assert.equal(data.tasks[0].duration, undefined);
  });

  it("handles workflow where no tasks have started", async () => {
    const tasks = [
      makeTask({
        taskDef: {
          kind: "agent",
          id: 1,
          prompt: "task 1",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        status: "pending",
      }),
      makeTask({
        taskDef: {
          kind: "agent",
          id: 2,
          prompt: "task 2",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        status: "pending",
      }),
    ];
    const wf = makeWorkflow(tasks);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // Neither task should have duration
    assert.equal(data.tasks[0].duration, undefined);
    assert.equal(data.tasks[1].duration, undefined);
  });

  it("calculates duration for failed tasks", async () => {
    const task = makeTask({
      status: "failed",
      startedAt: 1000,
      completedAt: 2500,
      error: "something went wrong",
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    assert.equal(data.tasks[0].duration, 1500);
  });

  it("calculates duration for paused tasks", async () => {
    const task = makeTask({
      status: "paused",
      startedAt: 1000,
      // not completed - paused in the middle
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // Paused tasks should have duration calculated from start to now
    assert.ok(data.tasks[0].duration! > 0);
  });

  it("calculates duration for skipped tasks", async () => {
    const task = makeTask({
      status: "skipped",
      startedAt: undefined, // Skipped tasks typically don't start
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    // Skipped tasks with no startedAt should not have duration
    assert.equal(data.tasks[0].duration, undefined);
  });

  it("preserves other task fields alongside duration", async () => {
    const task = makeTask({
      status: "done",
      startedAt: 1000,
      completedAt: 3000,
      output: "task output",
      error: undefined,
      sessionKey: "session:123",
    });
    const wf = makeWorkflow([task]);
    const deps = makeDeps(wf);

    const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as { tasks: TaskState[] };
    const resultTask = data.tasks[0];

    // Check duration is added
    assert.equal(resultTask.duration, 2000);

    // Check other fields are preserved
    assert.equal(resultTask.status, "done");
    assert.equal(resultTask.output, "task output");
    assert.equal(resultTask.startedAt, 1000);
    assert.equal(resultTask.completedAt, 3000);
    assert.equal(resultTask.sessionKey, "session:123");
  });
});
