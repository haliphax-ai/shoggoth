import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, TaskList } from "../src/types.js";
import {
  Orchestrator,
  type SpawnAdapter,
  type PollAdapter,
  type NotifyAdapter,
  type NotificationAdapter,
  type KillAdapter,
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "../src/orchestrator.js";
import { StatusManager } from "../src/status-manager.js";
import type { MessageAdapter } from "../src/message-adapter.js";
import { saveWorkflow, loadWorkflow } from "../src/state.js";
import { parseGraph } from "../src/graph.js";
import { ControlPlane } from "../src/control.js";
import { COMPLETED_MAX_AGE_MS } from "../src/retention.js";

// --- Mock helpers ---

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-integration-test-"));
}

function makeTask(
  id: number,
  prompt = `do task ${id}`,
  opts: Partial<Pick<TaskDef, "failureBehavior" | "failureNotification" | "runtimeLimitMs">> = {},
): TaskDef {
  return {
    id,
    prompt,
    failureBehavior: opts.failureBehavior ?? "continue",
    failureNotification: opts.failureNotification ?? "silent",
    runtimeLimitMs: opts.runtimeLimitMs,
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

function mockNotificationAdapter(): NotificationAdapter & { calls: Array<{ target: string; message: string }> } {
  const calls: Array<{ target: string; message: string }> = [];
  return {
    calls,
    async sendNotification(target: string, message: string): Promise<void> {
      calls.push({ target, message });
    },
  };
}

function mockKillAdapter(): KillAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async kill(sessionKey: string): Promise<void> {
      calls.push(sessionKey);
    },
  };
}

function mockMessageAdapter(): MessageAdapter & {
  posted: string[];
  edited: Array<{ id: string; content: string }>;
  nextId: number;
} {
  return {
    posted: [],
    edited: [],
    nextId: 1,
    async postMessage(content: string) {
      const messageId = `msg-${this.nextId++}`;
      this.posted.push(content);
      return { messageId };
    },
    async editMessage(messageId: string, content: string) {
      this.edited.push({ id: messageId, content });
      return true;
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
    runtimeLimitMs: 600_000,
  };
}

interface IntegrationSetup {
  orch: Orchestrator;
  cp: ControlPlane;
  wfId: string;
  spawner: SpawnAdapter & { calls: SpawnRequest[] };
  poller: PollAdapter & { results: Map<string, PollResult> };
  pollResults: Map<string, PollResult>;
  notifier: NotifyAdapter & { calls: Array<{ workflowId: string; success: boolean }> };
  notifications: NotificationAdapter & { calls: Array<{ target: string; message: string }> };
  killer: KillAdapter & { calls: string[] };
  msgAdapter: MessageAdapter & { posted: string[]; edited: Array<{ id: string; content: string }>; nextId: number };
  statusManager: StatusManager;
  orchestrators: Map<string, Orchestrator>;
  baseDir: string;
}

async function setup(
  baseDir: string,
  tasks: TaskDef[],
  graphDsl: string,
): Promise<IntegrationSetup> {
  const spawner = mockSpawnAdapter();
  const pollResults = new Map<string, PollResult>();
  const poller = mockPollAdapter(pollResults);
  const notifier = mockNotifyAdapter();
  const notifications = mockNotificationAdapter();
  const killer = mockKillAdapter();
  const msgAdapter = mockMessageAdapter();
  const statusManager = new StatusManager(msgAdapter);

  const orch = new Orchestrator(spawner, poller, notifier, statusManager, notifications, killer);
  const opts = defaultOpts(baseDir);
  const wfId = await orch.start(tasks, graphDsl, opts);

  const orchestrators = new Map<string, Orchestrator>();
  orchestrators.set(wfId, orch);

  const cp = new ControlPlane({
    orchestrators,
    stateDir: baseDir,
    killer,
    statusManager,
  });

  return {
    orch, cp, wfId, spawner, poller, pollResults, notifier,
    notifications, killer, msgAdapter, statusManager, orchestrators, baseDir,
  };
}

// --- Integration Tests ---

describe("Integration: happy path", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("executes tasks in dependency order and posts summary on completion", async () => {
    // Graph: 1 → 2 → 3 (sequential chain)
    const s = await setup(baseDir, [makeTask(1), makeTask(2), makeTask(3)], "1>2>3");

    // Task 1 should be spawned immediately
    assert.equal(s.spawner.calls.length, 1);
    assert.equal(s.spawner.calls[0].taskId, 1);

    // Complete task 1
    s.pollResults.set("session-1", { status: "done", output: "result-1" });
    await s.orch.tick();

    // Task 2 should now be spawned
    assert.equal(s.spawner.calls.length, 2);
    assert.equal(s.spawner.calls[1].taskId, 2);

    // Complete task 2
    s.pollResults.set("session-2", { status: "done", output: "result-2" });
    await s.orch.tick();

    // Task 3 should now be spawned
    assert.equal(s.spawner.calls.length, 3);
    assert.equal(s.spawner.calls[2].taskId, 3);

    // Complete task 3
    s.pollResults.set("session-3", { status: "done", output: "result-3" });
    await s.orch.tick();

    // Workflow should be complete
    assert.ok(s.orch.isComplete());

    // Notifier should have been called with success=true
    assert.equal(s.notifier.calls.length, 1);
    assert.ok(s.notifier.calls[0].success);

    // Summary message should have been posted
    const summaryPost = s.msgAdapter.posted.find((p) => p.includes("complete"));
    assert.ok(summaryPost, "summary message should be posted");

    // State should be persisted
    const loaded = loadWorkflow(baseDir, s.wfId)!;
    assert.ok(loaded);
    assert.ok(loaded.tasks.every((t) => t.status === "done"));
  });

  it("executes parallel tasks concurrently", async () => {
    // Graph: 1,2 → 3 (parallel roots, then join)
    const s = await setup(baseDir, [makeTask(1), makeTask(2), makeTask(3)], "1,2>3");

    // Tasks 1 and 2 should be spawned immediately
    assert.equal(s.spawner.calls.length, 2);
    const spawnedIds = s.spawner.calls.map((c) => c.taskId).sort();
    assert.deepStrictEqual(spawnedIds, [1, 2]);

    // Complete both
    s.pollResults.set("session-1", { status: "done", output: "r1" });
    s.pollResults.set("session-2", { status: "done", output: "r2" });
    await s.orch.tick();

    // Task 3 should now be spawned
    assert.equal(s.spawner.calls.length, 3);
    assert.equal(s.spawner.calls[2].taskId, 3);

    // Complete task 3
    s.pollResults.set("session-3", { status: "done", output: "r3" });
    await s.orch.tick();

    assert.ok(s.orch.isComplete());
    assert.ok(s.notifier.calls[0].success);
  });
});

describe("Integration: failure + retry", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("fails a task, retries it, and completes the workflow", async () => {
    const s = await setup(baseDir, [
      makeTask(1, "do task 1", { failureBehavior: "pause" }),
      makeTask(2),
    ], "1>2");

    // Fail task 1
    s.pollResults.set("session-1", { status: "failed", error: "transient error" });
    await s.orch.tick();

    const wf1 = s.orch.getWorkflowStatus()!;
    assert.equal(wf1.tasks.find((t) => t.taskDef.id === 1)!.status, "failed");
    assert.ok(s.orch.isPaused());

    // Retry task 1 via control plane
    await s.cp.retry(s.wfId, 1);
    assert.ok(!s.orch.isPaused());

    // Clear old poll result, tick to re-spawn
    s.pollResults.delete("session-1");
    await s.orch.tick();

    // Task 1 should be re-spawned
    const task1Spawns = s.spawner.calls.filter((c) => c.taskId === 1);
    assert.ok(task1Spawns.length >= 2);

    // Now complete task 1 successfully
    s.pollResults.set("session-1", { status: "done", output: "ok now" });
    await s.orch.tick();

    // Task 2 should be spawned
    const task2Spawns = s.spawner.calls.filter((c) => c.taskId === 2);
    assert.ok(task2Spawns.length >= 1);

    // Complete task 2
    s.pollResults.set("session-2", { status: "done", output: "done" });
    await s.orch.tick();

    assert.ok(s.orch.isComplete());
    assert.ok(s.notifier.calls[0].success);
  });
});

describe("Integration: failure + abort", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("aborts the workflow when a task fails with abort behavior", async () => {
    const s = await setup(baseDir, [
      makeTask(1, "root task"),
      makeTask(2, "abort task", { failureBehavior: "abort" }),
      makeTask(3, "downstream"),
    ], "1>2>3");

    // Complete task 1
    s.pollResults.set("session-1", { status: "done", output: "ok" });
    await s.orch.tick();

    // Fail task 2 with abort behavior
    s.pollResults.set("session-2", { status: "failed", error: "critical failure" });
    await s.orch.tick();

    // All tasks should be terminal
    const wf = s.orch.getWorkflowStatus()!;
    assert.equal(wf.tasks.find((t) => t.taskDef.id === 1)!.status, "done");
    assert.equal(wf.tasks.find((t) => t.taskDef.id === 2)!.status, "failed");
    assert.equal(wf.tasks.find((t) => t.taskDef.id === 3)!.status, "failed");

    // Task 3 should have been aborted (not spawned)
    const task3Error = wf.tasks.find((t) => t.taskDef.id === 3)!.error;
    assert.ok(task3Error?.includes("aborted"));
  });

  it("kills in-progress tasks on control plane abort", async () => {
    const s = await setup(baseDir, [makeTask(1), makeTask(2)], "1 2");

    // Both tasks are in_progress
    await s.cp.abort(s.wfId);

    assert.ok(s.killer.calls.includes("session-1"));
    assert.ok(s.killer.calls.includes("session-2"));
    assert.ok(s.orch.isComplete());

    const wf = s.orch.getWorkflowStatus()!;
    assert.ok(wf.tasks.every((t) => t.status === "failed"));
  });
});

describe("Integration: pause + resume", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("pauses, lets in-flight finish, resumes, and completes remaining tasks", async () => {
    const s = await setup(baseDir, [makeTask(1), makeTask(2), makeTask(3)], "1>2>3");

    // Task 1 is in_progress. Pause the workflow.
    await s.cp.pause(s.wfId);
    assert.ok(s.orch.isPaused());

    // Complete task 1 while paused — in-flight tasks still get polled
    s.pollResults.set("session-1", { status: "done", output: "result-1" });
    await s.orch.tick();

    // Task 1 should be done, but task 2 should NOT be spawned (paused)
    const wfPaused = s.orch.getWorkflowStatus()!;
    assert.equal(wfPaused.tasks.find((t) => t.taskDef.id === 1)!.status, "done");
    assert.equal(s.spawner.calls.filter((c) => c.taskId === 2).length, 0);

    // Resume
    await s.cp.resume(s.wfId);
    assert.ok(!s.orch.isPaused());

    // Tick to spawn task 2
    await s.orch.tick();
    assert.ok(s.spawner.calls.find((c) => c.taskId === 2));

    // Complete task 2
    s.pollResults.set("session-2", { status: "done", output: "result-2" });
    await s.orch.tick();

    // Task 3 should be spawned
    assert.ok(s.spawner.calls.find((c) => c.taskId === 3));

    // Complete task 3
    s.pollResults.set("session-3", { status: "done", output: "result-3" });
    await s.orch.tick();

    assert.ok(s.orch.isComplete());
    assert.ok(s.notifier.calls[0].success);
  });
});

describe("Integration: edit", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("edits a pending task prompt, then uses the edited prompt when spawned", async () => {
    const s = await setup(baseDir, [makeTask(1), makeTask(2, "original prompt")], "1>2");

    // Pause so we can edit task 2 before it runs
    await s.cp.pause(s.wfId);

    // Edit task 2's prompt
    await s.cp.edit(s.wfId, 2, { prompt: "edited prompt" });

    // Verify the edit persisted
    const wfEdited = s.orch.getWorkflowStatus()!;
    assert.equal(wfEdited.tasks.find((t) => t.taskDef.id === 2)!.taskDef.prompt, "edited prompt");

    // Resume and complete task 1
    await s.cp.resume(s.wfId);
    s.pollResults.set("session-1", { status: "done", output: "ok" });
    await s.orch.tick();

    // Task 2 should be spawned with the edited prompt
    const task2Spawn = s.spawner.calls.find((c) => c.taskId === 2);
    assert.ok(task2Spawn);
    assert.equal(task2Spawn!.prompt, "edited prompt");

    // Complete task 2
    s.pollResults.set("session-2", { status: "done", output: "done" });
    await s.orch.tick();

    assert.ok(s.orch.isComplete());
  });
});

describe("Integration: retention via control plane", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("prunes old completed workflows via control plane retention", async () => {
    const now = Date.now();
    const oldTime = now - COMPLETED_MAX_AGE_MS - 1_000;

    // Create an old completed workflow directly on disk
    const oldWf: TaskList = {
      id: "wf-old",
      name: "old-workflow",
      tasks: [
        { taskDef: makeTask(1), status: "done", output: "ok", startedAt: oldTime - 5_000, completedAt: oldTime },
      ],
      graph: parseGraph("1"),
      pollingIntervalMs: 50,
      createdAt: oldTime - 10_000,
    };
    saveWorkflow(baseDir, oldWf);

    // Create a recent workflow via the orchestrator
    const s = await setup(baseDir, [makeTask(1)], "1");

    // Run retention via control plane
    const result = await s.cp.retention({ now });

    assert.equal(result.pruned, 1);
    assert.deepStrictEqual(result.prunedIds, ["wf-old"]);

    // Old workflow should be gone
    assert.equal(loadWorkflow(baseDir, "wf-old"), undefined);

    // Active workflow should still exist
    assert.ok(loadWorkflow(baseDir, s.wfId));
  });

  it("removes pruned workflows from in-memory orchestrator map", async () => {
    const now = Date.now();
    const oldTime = now - COMPLETED_MAX_AGE_MS - 1_000;

    // Start a workflow and immediately complete it
    const s = await setup(baseDir, [makeTask(1)], "1");
    s.pollResults.set("session-1", { status: "done", output: "ok" });
    await s.orch.tick();
    assert.ok(s.orch.isComplete());

    // Manually backdate the persisted state to make it old
    const wf = loadWorkflow(baseDir, s.wfId)!;
    wf.createdAt = oldTime - 10_000;
    wf.tasks[0].completedAt = oldTime;
    saveWorkflow(baseDir, wf);

    // Run retention
    const result = await s.cp.retention({ now });
    assert.equal(result.pruned, 1);

    // Orchestrator should be removed from the map
    assert.equal(s.orchestrators.has(s.wfId), false);
  });
});

describe("Integration: status message lifecycle", () => {
  let baseDir: string;

  beforeEach(() => { baseDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it("posts initial status, edits on tick, and posts summary on completion", async () => {
    const s = await setup(baseDir, [makeTask(1)], "1");

    // Initial status should have been posted
    assert.ok(s.msgAdapter.posted.length >= 1);
    const initialPost = s.msgAdapter.posted[0];
    assert.ok(initialPost.includes("Task workflow"));

    // Tick — should edit the status message
    await s.orch.tick();
    assert.ok(s.msgAdapter.edited.length >= 1);

    // Complete task 1
    s.pollResults.set("session-1", { status: "done", output: "ok" });
    await s.orch.tick();

    // Summary should be posted
    const summaryPost = s.msgAdapter.posted.find((p) => p.includes("complete"));
    assert.ok(summaryPost);
  });
});
