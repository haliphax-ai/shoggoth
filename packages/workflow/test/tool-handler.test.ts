import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  handleWorkflowToolCall,
  type WorkflowToolArgs,
  type WorkflowToolHandlerDeps,
} from "../src/tool-handler.js";
import type { WorkflowServer } from "../src/server.js";
import type { ControlPlane } from "../src/control.js";
import type { TaskList } from "../src/types.js";

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

    it("converts message task with message and channel", async () => {
      let capturedTasks: unknown;
      const server = mockServer({
        start: async (tasks) => {
          capturedTasks = tasks;
          return "wf-msg";
        },
      });
      const deps = makeDeps({ server });
      await handleWorkflowToolCall({
        action: "start",
        tasks: [
          { id: 1, kind: "message", message: "Hello world", channel: "channel:123" },
        ],
        graph: "",
        reply_to: "session:parent",
      }, deps);

      const tasks = capturedTasks as Array<{ kind: string; message: string; channel?: string }>;
      assert.equal(tasks[0].kind, "message");
      assert.equal(tasks[0].message, "Hello world");
      assert.equal(tasks[0].channel, "channel:123");
    });

    it("converts message task without channel", async () => {
      let capturedTasks: unknown;
      const server = mockServer({
        start: async (tasks) => {
          capturedTasks = tasks;
          return "wf-msg-no-channel";
        },
      });
      const deps = makeDeps({ server });
      await handleWorkflowToolCall({
        action: "start",
        tasks: [
          { id: 1, kind: "message", message: "Test message" },
        ],
        graph: "",
        reply_to: "session:parent",
      }, deps);

      const tasks = capturedTasks as Array<{ kind: string; message: string; channel?: string }>;
      assert.equal(tasks[0].kind, "message");
      assert.equal(tasks[0].message, "Test message");
      assert.equal(tasks[0].channel, undefined);
    });

    it("returns error when message task is missing message field", async () => {
      const result = await handleWorkflowToolCall({
        action: "start",
        tasks: [
          { id: 1, kind: "message" },
        ],
        graph: "",
        reply_to: "session:parent",
      } as unknown as WorkflowToolArgs, makeDeps());

      assert.equal(result.ok, false);
      assert.match(result.error!, /message/);
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
