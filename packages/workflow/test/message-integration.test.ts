import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";
import type { SpawnAdapter, PollAdapter, NotifyAdapter, MessagePoster } from "../src/orchestrator.js";
import type { TaskDef, ToolExecutor } from "../src/types.js";

describe("Message task integration with all task types", () => {
  it("executes workflow with agent, tool, gate, transform, and message tasks", async () => {
    const executedTasks: string[] = [];
    const postedMessages: Array<{ target: string; message: string }> = [];

    const spawner: SpawnAdapter = {
      spawn: async (req) => {
        executedTasks.push(`agent:${req.taskId}`);
        return `session:${req.taskId}`;
      },
    };

    const poller: PollAdapter = {
      poll: async (sessionKey) => {
        const taskId = parseInt(sessionKey.split(":")[1]);
        return {
          status: "done",
          output: `result-${taskId}`,
        };
      },
    };

    const notifier: NotifyAdapter = {
      notify: async () => {},
    };

    const messagePoster: MessagePoster = {
      post: async (target, message) => {
        postedMessages.push({ target, message });
      },
    };

    const toolExecutor: ToolExecutor = {
      execute: async (call: { name: string; argsJson: string; toolCallId: string }) => {
        executedTasks.push(`tool:${call.name}`);
        return { resultJson: JSON.stringify({ output: `tool-output-${call.name}` }) };
      },
    };

    const orchestrator = new Orchestrator(
      spawner,
      poller,
      notifier,
      undefined,
      undefined,
      undefined,
      messagePoster,
      toolExecutor,
    );

    // Define workflow with all task types
    const tasks: TaskDef[] = [
      // Task 1: Agent (root)
      { id: 1, kind: "agent", prompt: "Do initial work", failureBehavior: "continue", failureNotification: "silent" },

      // Task 2: Tool (depends on 1, can run in parallel with 3)
      { id: 2, kind: "tool", tool: "fetch-data", args: { url: "https://example.com" }, failureBehavior: "continue", failureNotification: "silent" },

      // Task 3: Gate (depends on 1, can run in parallel with 2)
      { id: 3, kind: "gate", condition: "true", failureBehavior: "continue", failureNotification: "silent" },

      // Task 4: Transform (depends on 2 and 3)
      { id: 4, kind: "transform", template: "Combined: {{task:2:output}} and {{task:3:output}}", failureBehavior: "continue", failureNotification: "silent" },

      // Task 5: Message (depends on 4, uses template)
      { id: 5, kind: "message", message: "Workflow result: {{task:4:output}}", channel: "channel:results", failureBehavior: "continue", failureNotification: "silent" },
    ];

    const graphDsl = "1 2,3>4>5";

    const workflowId = await orchestrator.start(tasks, graphDsl, {
      stateDir: "/tmp/test-workflow",
      currentDepth: 0,
      maxDepth: 2,
      replyTo: "session:parent",
      pollingIntervalMs: 100,
      runtimeLimitMs: 5000,
      name: "test-all-types",
      concurrency: 2,
    });

    assert.ok(workflowId);

    // Run orchestration ticks
    for (let i = 0; i < 10; i++) {
      await orchestrator.tick();
      if (orchestrator.isComplete()) break;
    }

    assert.ok(orchestrator.isComplete());

    const status = orchestrator.getWorkflowStatus();
    assert.ok(status);
    assert.equal(status.tasks.length, 5);

    // Verify all tasks completed
    const allDone = status.tasks.every((t) => t.status === "done");
    assert.ok(allDone, "All tasks should be done");

    // Verify agent task was spawned
    assert.ok(executedTasks.includes("agent:1"));

    // Verify tool task was executed
    assert.ok(executedTasks.includes("tool:fetch-data"));

    // Verify message was posted
    assert.equal(postedMessages.length, 1);
    assert.equal(postedMessages[0].target, "channel:results");
    assert.match(postedMessages[0].message, /Workflow result:/);
  });

  it("handles message task with template resolution from multiple dependencies", async () => {
    const postedMessages: Array<{ target: string; message: string }> = [];

    const spawner: SpawnAdapter = {
      spawn: async () => "session:1",
    };

    const poller: PollAdapter = {
      poll: async () => ({
        status: "done",
        output: "agent-output",
      }),
    };

    const notifier: NotifyAdapter = {
      notify: async () => {},
    };

    const messagePoster: MessagePoster = {
      post: async (target, message) => {
        postedMessages.push({ target, message });
      },
    };

    const toolExecutor: ToolExecutor = {
      execute: async () => ({
        resultJson: JSON.stringify({ output: "tool-output" }),
      }),
    };

    const orchestrator = new Orchestrator(
      spawner,
      poller,
      notifier,
      undefined,
      undefined,
      undefined,
      messagePoster,
      toolExecutor,
    );

    const tasks: TaskDef[] = [
      { id: 1, kind: "agent", prompt: "Task 1", failureBehavior: "continue", failureNotification: "silent" },
      { id: 2, kind: "tool", tool: "process", args: {}, failureBehavior: "continue", failureNotification: "silent" },
      {
        id: 3,
        kind: "message",
        message: "Results: Agent={{task:1:output}}, Tool={{task:2:output}}",
        channel: "channel:summary",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
    ];

    const graphDsl = "1,2>3";

    await orchestrator.start(tasks, graphDsl, {
      stateDir: "/tmp/test-workflow-2",
      currentDepth: 0,
      maxDepth: 2,
      replyTo: "session:parent",
      pollingIntervalMs: 100,
      runtimeLimitMs: 5000,
    });

    for (let i = 0; i < 10; i++) {
      await orchestrator.tick();
      if (orchestrator.isComplete()) break;
    }

    assert.ok(orchestrator.isComplete());
    assert.equal(postedMessages.length, 1);
    assert.equal(postedMessages[0].message, "Results: Agent=agent-output, Tool=tool-output");
  });
});
