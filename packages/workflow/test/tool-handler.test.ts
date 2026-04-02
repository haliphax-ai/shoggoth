import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import {
  handleWorkflowToolCall,
  type WorkflowToolArgs,
  type WorkflowToolHandlerDeps,
} from "../src/tool-handler.js";
import type { WorkflowServer } from "../src/server.js";
import type { ControlPlane } from "../src/control.js";
import type { TaskList } from "../src/types.js";

// --- Mocks ---

function mockServer(overrides: Partial<WorkflowServer> = {}): WorkflowServer {
  return {
    start: async () => "wf-123",
    resume: async () => [],
    get: () => undefined,
    stopAll: async () => {},
    ...overrides,
  } as unknown as WorkflowServer;
}

function mockControlPlane(overrides: Partial<Record<string, unknown>> = {}): ControlPlane {
  return {
    abort: async () => {},
    pause: async () => {},
    resume: async () => {},
    status: async () => ({ id: "wf-123", name: "test", tasks: [], graph: new Map(), pollingIntervalMs: 10000, createdAt: Date.now() }) as TaskList,
    list: async () => [],
    post: async () => {},
    edit: async () => {},
    retry: async () => {},
    retention: async () => ({ prunedIds: [], prunedCount: 0 }),
    ...overrides,
  } as unknown as ControlPlane;
}

function makeDeps(overrides: Partial<WorkflowToolHandlerDeps> = {}): WorkflowToolHandlerDeps {
  return {
    server: mockServer(),
    controlPlane: mockControlPlane(),
    stateDir: "/tmp/workflow-test",
    currentDepth: 0,
    maxDepth: 2,
    ...overrides,
  };
}

const sampleTasks = [
  { id: 1, prompt: "Do thing one" },
  { id: 2, prompt: "Do thing two" },
];

// --- Tests ---

describe("handleWorkflowToolCall", () => {
  describe("start", () => {
    it("calls server.start and returns workflow_id", async () => {
      let captured: unknown;
      const server = mockServer({
        start: async (tasks, graph, opts) => {
          captured = { tasks, graph, opts };
          return "wf-abc";
        },
      });
      const deps = makeDeps({ server });
      const result = await handleWorkflowToolCall({
        action: "start",
        name: "my-workflow",
        tasks: sampleTasks,
        graph: "1>2",
        reply_to: "session:parent",
      }, deps);

      assert.equal(result.ok, true);
      assert.deepEqual((result.data as Record<string, unknown>).workflow_id, "wf-abc");
      assert.ok(captured);
    });

    it("returns error when tasks is missing", async () => {
      const result = await handleWorkflowToolCall({
        action: "start",
        graph: "1>2",
        reply_to: "session:parent",
      } as WorkflowToolArgs, makeDeps());

      assert.equal(result.ok, false);
      assert.match(result.error!, /tasks/);
    });

    it("returns error when graph is missing", async () => {
      const result = await handleWorkflowToolCall({
        action: "start",
        tasks: sampleTasks,
        reply_to: "session:parent",
      } as WorkflowToolArgs, makeDeps());

      assert.equal(result.ok, false);
      assert.match(result.error!, /graph/);
    });

    it("returns error when reply_to is missing", async () => {
      const result = await handleWorkflowToolCall({
        action: "start",
        tasks: sampleTasks,
        graph: "1>2",
      } as WorkflowToolArgs, makeDeps());

      assert.equal(result.ok, false);
      assert.match(result.error!, /reply_to/);
    });

    it("normalizes task failure_notification from snake_case input", async () => {
      let capturedTasks: unknown;
      const server = mockServer({
        start: async (tasks) => {
          capturedTasks = tasks;
          return "wf-norm";
        },
      });
      const deps = makeDeps({ server });
      await handleWorkflowToolCall({
        action: "start",
        tasks: [
          { id: 1, prompt: "test", failure_notification: { kind: "notify-target", target_id: "agent:foo" } },
        ],
        graph: "",
        reply_to: "session:parent",
      }, deps);

      const tasks = capturedTasks as Array<{ failureNotification: { kind: string; targetId: string } }>;
      assert.equal(tasks[0].failureNotification.kind, "notify-target");
      assert.equal(tasks[0].failureNotification.targetId, "agent:foo");
    });

    it("uses default polling and runtime limits when not specified", async () => {
      let capturedOpts: unknown;
      const server = mockServer({
        start: async (_tasks, _graph, opts) => {
          capturedOpts = opts;
          return "wf-defaults";
        },
      });
      const deps = makeDeps({ server });
      await handleWorkflowToolCall({
        action: "start",
        tasks: sampleTasks,
        graph: "1>2",
        reply_to: "session:parent",
      }, deps);

      const opts = capturedOpts as { pollingIntervalMs: number; runtimeLimitMs: number };
      assert.equal(opts.pollingIntervalMs, 10_000);
      assert.equal(opts.runtimeLimitMs, 600_000);
    });
  });

  describe("abort", () => {
    it("calls controlPlane.abort with workflow_id", async () => {
      let abortedId: string | undefined;
      const cp = mockControlPlane({ abort: async (id: string) => { abortedId = id; } });
      const result = await handleWorkflowToolCall({ action: "abort", workflow_id: "wf-1" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.equal(abortedId, "wf-1");
    });

    it("returns error when workflow_id is missing", async () => {
      const result = await handleWorkflowToolCall({ action: "abort" } as WorkflowToolArgs, makeDeps());
      assert.equal(result.ok, false);
      assert.match(result.error!, /workflow_id/);
    });
  });

  describe("pause", () => {
    it("calls controlPlane.pause", async () => {
      let pausedId: string | undefined;
      const cp = mockControlPlane({ pause: async (id: string) => { pausedId = id; } });
      const result = await handleWorkflowToolCall({ action: "pause", workflow_id: "wf-2" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.equal(pausedId, "wf-2");
    });
  });

  describe("resume", () => {
    it("calls controlPlane.resume", async () => {
      let resumedId: string | undefined;
      const cp = mockControlPlane({ resume: async (id: string) => { resumedId = id; } });
      const result = await handleWorkflowToolCall({ action: "resume", workflow_id: "wf-3" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.equal(resumedId, "wf-3");
    });
  });

  describe("status", () => {
    it("returns workflow data", async () => {
      const result = await handleWorkflowToolCall({ action: "status", workflow_id: "wf-4" }, makeDeps());
      assert.equal(result.ok, true);
      assert.ok(result.data);
    });
  });

  describe("list", () => {
    it("returns workflow summaries", async () => {
      const cp = mockControlPlane({ list: async () => [{ id: "wf-1", name: "test", statusCounts: {}, createdAt: 0 }] });
      const result = await handleWorkflowToolCall({ action: "list" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.equal((result.data as unknown[]).length, 1);
    });

    it("passes agent_chain_id filter", async () => {
      let capturedChain: string | undefined;
      const cp = mockControlPlane({ list: async (chain?: string) => { capturedChain = chain; return []; } });
      await handleWorkflowToolCall({ action: "list", agent_chain_id: "agent:dev" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(capturedChain, "agent:dev");
    });
  });

  describe("post", () => {
    it("calls controlPlane.post", async () => {
      let postedId: string | undefined;
      const cp = mockControlPlane({ post: async (id: string) => { postedId = id; } });
      const result = await handleWorkflowToolCall({ action: "post", workflow_id: "wf-5" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.equal(postedId, "wf-5");
    });
  });

  describe("edit", () => {
    it("calls controlPlane.edit with updates", async () => {
      let capturedArgs: unknown;
      const cp = mockControlPlane({
        edit: async (wfId: string, taskId: number, updates: unknown) => { capturedArgs = { wfId, taskId, updates }; },
      });
      const result = await handleWorkflowToolCall({
        action: "edit",
        workflow_id: "wf-6",
        task_id: 3,
        prompt: "new prompt",
        failure_behavior: "abort",
      }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      const args = capturedArgs as { wfId: string; taskId: number; updates: Record<string, unknown> };
      assert.equal(args.wfId, "wf-6");
      assert.equal(args.taskId, 3);
      assert.equal(args.updates.prompt, "new prompt");
      assert.equal(args.updates.failureBehavior, "abort");
    });

    it("returns error when task_id is missing", async () => {
      const result = await handleWorkflowToolCall({ action: "edit", workflow_id: "wf-6" } as WorkflowToolArgs, makeDeps());
      assert.equal(result.ok, false);
      assert.match(result.error!, /task_id/);
    });
  });

  describe("retry", () => {
    it("calls controlPlane.retry with cascade", async () => {
      let capturedArgs: unknown;
      const cp = mockControlPlane({
        retry: async (wfId: string, taskId: number, cascade?: boolean) => { capturedArgs = { wfId, taskId, cascade }; },
      });
      const result = await handleWorkflowToolCall({
        action: "retry",
        workflow_id: "wf-7",
        task_id: 2,
        cascade: true,
      }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      const args = capturedArgs as { wfId: string; taskId: number; cascade: boolean };
      assert.equal(args.cascade, true);
    });
  });

  describe("retention", () => {
    it("calls controlPlane.retention and returns summary", async () => {
      const cp = mockControlPlane({ retention: async () => ({ prunedIds: ["old-1"], prunedCount: 1 }) });
      const result = await handleWorkflowToolCall({ action: "retention" }, makeDeps({ controlPlane: cp as unknown as ControlPlane }));

      assert.equal(result.ok, true);
      assert.deepEqual((result.data as Record<string, unknown>).prunedCount, 1);
    });
  });

  describe("unknown action", () => {
    it("returns error for unknown action", async () => {
      const result = await handleWorkflowToolCall({ action: "explode" } as unknown as WorkflowToolArgs, makeDeps());
      assert.equal(result.ok, false);
      assert.match(result.error!, /Unknown action/);
    });
  });
});
