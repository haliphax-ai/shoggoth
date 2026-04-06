import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, ToolExecutor } from "../src/types.js";
import {
  Orchestrator,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "../src/orchestrator.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tool-task-test-"));
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

function makeToolTask(id: number, tool: string, args?: Record<string, unknown>): TaskDef {
  return {
    kind: "tool",
    id,
    tool,
    args,
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

function mockToolExecutor(
  handler: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: string; error?: string }>,
): ToolExecutor & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async execute(call: { name: string; argsJson: string; toolCallId: string }) {
      const args = JSON.parse(call.argsJson) as Record<string, unknown>;
      calls.push({ tool: call.name, args });
      const result = await handler(call.name, args);
      if (result.ok) {
        return { resultJson: JSON.stringify({ output: result.output }) };
      }
      return { resultJson: JSON.stringify({ error: result.error ?? "tool execution failed" }) };
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

describe("Tool task execution", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("executes a tool task synchronously and marks it done", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "tool result" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks = [makeToolTask(1, "builtin-read", { path: "foo.txt" })];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks[0];
    assert.equal(task1.status, "done");
    assert.equal(task1.output, "tool result");
    assert.ok(task1.startedAt);
    assert.ok(task1.completedAt);
    // No subagent session should be spawned
    assert.equal(spawner.calls.length, 0);
  });

  it("marks tool task as failed when executor returns ok: false", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: false, output: "", error: "file not found" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks = [makeToolTask(1, "builtin-read", { path: "missing.txt" })];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks[0];
    assert.equal(task1.status, "failed");
    assert.equal(task1.error, "file not found");
  });

  it("marks tool task as failed when executor throws", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => { throw new Error("connection refused"); });
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks = [makeToolTask(1, "builtin-exec", { argv: ["ls"] })];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks[0];
    assert.equal(task1.status, "failed");
    assert.equal(task1.error, "connection refused");
  });

  it("fails tool task with clear error when no ToolExecutor is provided", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    // No toolExecutor passed
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeToolTask(1, "builtin-read", { path: "foo.txt" })];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks[0];
    assert.equal(task1.status, "failed");
    assert.match(task1.error!, /ToolExecutor/);
  });

  it("resolves template refs in tool args", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "ok" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeToolTask(2, "builtin-exec", { argv: ["echo", "{{task:1:output}}"], flag: "{{task:1:success}}" }),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Complete agent task 1
    pollResults.set("session-1", { status: "done", output: "hello" });
    await orch.tick();

    // Tool task 2 should have been executed with resolved args
    assert.equal(executor.calls.length, 1);
    assert.deepStrictEqual(executor.calls[0].args, { argv: ["echo", "hello"], flag: "true" });
  });

  it("resolves nested template refs in tool args", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "ok" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeToolTask(2, "builtin-write", {
        path: "out.txt",
        nested: { deep: "{{task:1:output}}", num: 42 },
      }),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    pollResults.set("session-1", { status: "done", output: "data" });
    await orch.tick();

    assert.equal(executor.calls.length, 1);
    assert.deepStrictEqual(executor.calls[0].args, {
      path: "out.txt",
      nested: { deep: "data", num: 42 },
    });
  });

  it("passes empty args when tool task has no args", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "done" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks = [makeToolTask(1, "some-tool")];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0].tool, "some-tool");
    assert.deepStrictEqual(executor.calls[0].args, {});
  });

  it("tool task output is available to downstream agent tasks via templates", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "file contents here" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeToolTask(1, "builtin-read", { path: "data.txt" }),
      makeAgentTask(2, "Process: {{task:1:output}}"),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Tool task 1 completes synchronously during start, so task 2 should also be spawned
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0].taskId, 2);
    assert.equal(spawner.calls[0].prompt, "Process: file contents here");
  });

  it("tool task output is available to downstream tool tasks via templates", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async (_tool, args) => ({
      ok: true,
      output: `executed: ${JSON.stringify(args)}`,
    }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeToolTask(1, "builtin-read", { path: "input.txt" }),
      makeToolTask(2, "builtin-exec", { argv: ["process", "{{task:1:output}}"] }),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Both tool tasks should complete synchronously during start
    const wf = orch.getWorkflowStatus()!;
    assert.equal(wf.tasks[0].status, "done");
    assert.equal(wf.tasks[1].status, "done");
    assert.equal(executor.calls.length, 2);
    // Second call should have resolved template from first task's output
    assert.deepStrictEqual(executor.calls[1].args, {
      argv: ["process", 'executed: {"path":"input.txt"}'],
    });
  });

  it("failed tool task blocks downstream tasks", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: false, output: "", error: "boom" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeToolTask(1, "builtin-exec", { argv: ["fail"] }),
      makeAgentTask(2, "should not run"),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Tick to propagate blocked status
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    assert.equal(wf.tasks[0].status, "failed");
    assert.equal(wf.tasks[1].status, "failed");
    assert.match(wf.tasks[1].error!, /blocked/);
    assert.equal(spawner.calls.length, 0);
  });

  it("tool task respects abort failure behavior", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: false, output: "", error: "crash" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const failingTool: TaskDef = {
      kind: "tool",
      id: 1,
      tool: "builtin-exec",
      args: { argv: ["crash"] },
      failureBehavior: "abort",
      failureNotification: "silent",
    };
    const tasks: TaskDef[] = [failingTool, makeAgentTask(2)];
    await orch.start(tasks, "1 2", defaultOpts(baseDir));

    // Tool task 1 fails during start; tick to process failure behavior
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    assert.equal(wf.tasks[0].status, "failed");
    assert.equal(wf.tasks[0].error, "crash");
    // Task 2 should be aborted
    assert.equal(wf.tasks[1].status, "failed");
  });

  it("tool task respects concurrency limits", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    let callCount = 0;
    const executor = mockToolExecutor(async () => {
      callCount++;
      return { ok: true, output: `result-${callCount}` };
    });
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    // 3 independent tasks: 1 agent + 2 tool, concurrency 1
    const tasks: TaskDef[] = [
      makeAgentTask(1),
      makeToolTask(2, "builtin-read"),
      makeToolTask(3, "builtin-read"),
    ];
    const opts = { ...defaultOpts(baseDir), concurrency: 1 };
    await orch.start(tasks, "1 2 3", opts);

    // With concurrency 1, only one task should have started
    // Agent task 1 comes first in the array, so it gets spawned as in_progress
    const wf = orch.getWorkflowStatus()!;
    const inProgress = wf.tasks.filter((t) => t.status === "in_progress").length;
    const done = wf.tasks.filter((t) => t.status === "done").length;
    // At most 1 should be in_progress at a time; tool tasks complete synchronously
    // so they transition to done immediately, but concurrency check happens before each
    assert.ok(inProgress <= 1, `expected at most 1 in_progress, got ${inProgress}`);
  });

  it("workflow completes successfully with only tool tasks", async () => {
    const spawner = mockSpawnAdapter();
    const poller = mockPollAdapter(new Map());
    const notifier = mockNotifyAdapter();
    const executor = mockToolExecutor(async () => ({ ok: true, output: "done" }));
    const orch = new Orchestrator(spawner, poller, notifier, undefined, undefined, undefined, undefined, executor);

    const tasks: TaskDef[] = [
      makeToolTask(1, "builtin-read", { path: "a.txt" }),
      makeToolTask(2, "builtin-read", { path: "b.txt" }),
    ];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Both complete synchronously during start; tick to trigger completion check
    await orch.tick();

    assert.ok(orch.isComplete());
    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].success, true);
    assert.equal(spawner.calls.length, 0); // no subagent sessions
  });
});
