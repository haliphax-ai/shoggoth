import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, TransformTaskDef, MessageTaskDef } from "../src/types.js";
import {
  Orchestrator,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type MessagePoster,
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "../src/orchestrator.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-task-types-test-"));
}

function makeAgentTask(id: number, prompt = `do task ${id}`): TaskDef {
  return {
    kind: "agent",
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeTransformTask(id: number, template: string): TransformTaskDef {
  return {
    kind: "transform",
    id,
    template,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function makeMessageTask(id: number, message: string, channel?: string): MessageTaskDef {
  return {
    kind: "message",
    id,
    message,
    ...(channel ? { channel } : {}),
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

function mockSpawnAdapter(): SpawnAdapter & { calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  return {
    calls,
    async spawn(req: SpawnRequest): Promise<string> {
      calls.push(req);
      return `session-${req.taskId}`;
    },
  };
}

function mockPollAdapter(
  results: Map<string, PollResult>,
): PollAdapter & { results: Map<string, PollResult> } {
  return {
    results,
    async poll(sessionKey: string): Promise<PollResult> {
      return results.get(sessionKey) ?? { status: "running" };
    },
  };
}

function mockNotifyAdapter(): NotifyAdapter & { calls: Array<{ workflowId: string; success: boolean }> } {
  const calls: Array<{ workflowId: string; success: boolean }> = [];
  return {
    calls,
    async notify(workflowId: string, success: boolean): Promise<void> {
      calls.push({ workflowId, success });
    },
  };
}

function mockMessagePoster(): MessagePoster & { calls: Array<{ sessionId: string; message: string }> } {
  const calls: Array<{ sessionId: string; message: string }> = [];
  return {
    calls,
    async post(sessionId: string, message: string): Promise<void> {
      calls.push({ sessionId, message });
    },
  };
}

function defaultOpts(baseDir: string): OrchestratorOptions {
  return {
    stateDir: baseDir,
    currentDepth: 0,
    maxDepth: 2,
    replyTo: "agent:parent",
    pollingIntervalMs: 50,
    runtimeLimitMs: 60_000,
  };
}

describe("Transform tasks", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("executes a transform task with a static template", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [makeTransformTask(1, "hello world")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const status = orch.getWorkflowStatus()!;
    const task1 = status.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "done");
    assert.equal(task1.output, "hello world");
    assert.ok(task1.startedAt);
    assert.ok(task1.completedAt);
  });

  it("does not spawn a subagent for transform tasks", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [makeTransformTask(1, "no agent needed")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    assert.equal(spawner.calls.length, 0);
  });

  it("resolves template refs from upstream task output", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeTransformTask(2, "Result: {{task:1:output}}, success: {{task:1:success}}"),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Complete agent task 1
    pollResults.set("session-1", { status: "done", output: "42" });
    await orch.tick();

    const status = orch.getWorkflowStatus()!;
    const task2 = status.tasks.find((t) => t.taskDef.id === 2)!;
    assert.equal(task2.status, "done");
    assert.equal(task2.output, "Result: 42, success: true");
  });

  it("completes the workflow when only transform tasks exist", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [makeTransformTask(1, "step one")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    // Transform completes synchronously during start → workflow should be done after one tick
    await orch.tick();

    assert.ok(orch.isComplete());
    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].success, true);
  });

  it("chains transform tasks", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [
      makeTransformTask(1, "hello"),
      makeTransformTask(2, "{{task:1:output}} world"),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Task 1 completes during start; task 2 needs a tick to see task 1 done
    await orch.tick();

    const status = orch.getWorkflowStatus()!;
    const task2 = status.tasks.find((t) => t.taskDef.id === 2)!;
    assert.equal(task2.status, "done");
    assert.equal(task2.output, "hello world");
  });

  it("validates template refs in transform tasks at start time", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    // Task 1 references task 2 but doesn't depend on it
    const tasks: TaskDef[] = [
      makeTransformTask(1, "{{task:2:output}}"),
      makeTransformTask(2, "data"),
    ];
    await assert.rejects(
      () => orch.start(tasks, "1 2", defaultOpts(baseDir)),
      /not a direct or transitive dependency/,
    );
  });
});

describe("Message tasks", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("posts a message to the default replyTo channel", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [makeMessageTask(1, "hello from workflow")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const status = orch.getWorkflowStatus()!;
    const task1 = status.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "done");
    assert.equal(task1.output, "hello from workflow");

    assert.equal(poster.calls.length, 1);
    assert.equal(poster.calls[0].sessionId, "agent:parent");
    assert.equal(poster.calls[0].message, "hello from workflow");
  });

  it("posts to a custom channel when specified", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [makeMessageTask(1, "targeted message", "custom:channel:123")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    assert.equal(poster.calls.length, 1);
    assert.equal(poster.calls[0].sessionId, "custom:channel:123");
  });

  it("resolves template refs in message body", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeMessageTask(2, "Agent said: {{task:1:output}}"),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    pollResults.set("session-1", { status: "done", output: "I'm done!" });
    await orch.tick();

    const status = orch.getWorkflowStatus()!;
    const task2 = status.tasks.find((t) => t.taskDef.id === 2)!;
    assert.equal(task2.status, "done");
    assert.equal(task2.output, "Agent said: I'm done!");
    assert.equal(poster.calls[0].message, "Agent said: I'm done!");
  });

  it("fails when no MessagePoster is provided", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    // No messagePoster passed
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks: TaskDef[] = [makeMessageTask(1, "this will fail")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const status = orch.getWorkflowStatus()!;
    const task1 = status.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
    assert.ok(task1.error?.includes("MessagePoster"));
  });

  it("fails when MessagePoster.post throws", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const poster: MessagePoster = {
      async post() {
        throw new Error("network error");
      },
    };
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [makeMessageTask(1, "will fail")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const status = orch.getWorkflowStatus()!;
    const task1 = status.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
    assert.equal(task1.error, "network error");
  });

  it("does not spawn a subagent for message tasks", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [makeMessageTask(1, "no agent")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    assert.equal(spawner.calls.length, 0);
  });

  it("validates template refs in message tasks at start time", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [
      makeMessageTask(1, "{{task:2:output}}"),
      makeTransformTask(2, "data"),
    ];
    await assert.rejects(
      () => orch.start(tasks, "1 2", defaultOpts(baseDir)),
      /not a direct or transitive dependency/,
    );
  });
});

describe("Mixed task type workflows", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("runs agent → transform → message pipeline", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const poster = mockMessagePoster();
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, poster);

    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeTransformTask(2, "Summary: {{task:1:output}}"),
      makeMessageTask(3, "{{task:2:output}}"),
    ];
    await orch.start(tasks, "1>2>3", defaultOpts(baseDir));

    // Complete agent task
    pollResults.set("session-1", { status: "done", output: "analysis complete" });
    await orch.tick();

    // Transform and message should both be done after one more tick
    await orch.tick();

    const status = orch.getWorkflowStatus()!;
    assert.equal(status.tasks[0].status, "done");
    assert.equal(status.tasks[1].status, "done");
    assert.equal(status.tasks[1].output, "Summary: analysis complete");
    assert.equal(status.tasks[2].status, "done");
    assert.equal(poster.calls[0].message, "Summary: analysis complete");

    assert.ok(orch.isComplete());
    assert.equal(notifier.calls[0].success, true);
  });

  it("tool task fails when no ToolExecutor provided", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const toolTask: TaskDef = {
      kind: "tool",
      id: 1,
      tool: "builtin-exec",
      args: { argv: ["echo", "hi"] },
      failureBehavior: "continue",
      failureNotification: "silent",
    };

    await orch.start([toolTask], "1", defaultOpts(baseDir));

    const status = orch.getWorkflowStatus()!;
    assert.equal(status.tasks[0].status, "failed");
    assert.ok(status.tasks[0].error?.includes("ToolExecutor"));
  });
});
