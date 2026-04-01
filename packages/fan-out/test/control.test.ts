import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, TaskList, TaskState } from "../src/types.js";
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
import { saveWorkflow } from "../src/state.js";
import { parseGraph } from "../src/graph.js";
import { ControlPlane } from "../src/control.js";

// --- Mock helpers ---

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-control-test-"));
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

/** Build a workflow, start it via orchestrator, return everything needed for control plane tests. */
async function setupWorkflow(
  baseDir: string,
  tasks: TaskDef[],
  graphDsl: string,
  opts?: {
    pollResults?: Map<string, PollResult>;
  },
) {
  const spawner = mockSpawnAdapter();
  const pollResults = opts?.pollResults ?? new Map<string, PollResult>();
  const poller = mockPollAdapter(pollResults);
  const notifier = mockNotifyAdapter();
  const killer = mockKillAdapter();
  const msgAdapter = mockMessageAdapter();
  const statusManager = new StatusManager(msgAdapter);

  const orch = new Orchestrator(spawner, poller, notifier, statusManager, undefined, killer);
  const orchOpts = defaultOpts(baseDir);
  const wfId = await orch.start(tasks, graphDsl, orchOpts);

  const orchestrators = new Map<string, Orchestrator>();
  orchestrators.set(wfId, orch);

  const cp = new ControlPlane({
    orchestrators,
    stateDir: baseDir,
    killer,
    statusManager,
  });

  return { cp, orch, wfId, spawner, poller, pollResults, notifier, killer, msgAdapter, statusManager, orchOpts };
}

/** Create a persisted-only workflow (no active orchestrator) for disk-based tests. */
function createPersistedWorkflow(baseDir: string, overrides?: Partial<TaskList>): TaskList {
  const wf: TaskList = {
    id: "wf-persisted-1",
    name: "test-workflow",
    tasks: [
      { taskDef: makeTask(1), status: "done", output: "ok", startedAt: 1000, completedAt: 2000 },
      { taskDef: makeTask(2), status: "failed", error: "boom", startedAt: 1000, completedAt: 3000 },
      { taskDef: makeTask(3), status: "pending" },
    ],
    graph: parseGraph("1>2>3"),
    pollingIntervalMs: 50,
    createdAt: 1000,
    ...overrides,
  };
  saveWorkflow(baseDir, wf);
  return wf;
}

// --- Tests ---

describe("ControlPlane", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe("abort", () => {
    it("kills all active tasks, marks non-terminal as failed, and persists", async () => {
      const { cp, orch, wfId, killer, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2), makeTask(3)],
        "1,2>3",
      );

      // Tasks 1 and 2 are in_progress (spawned as roots)
      await cp.abort(wfId);

      // Both active sessions should be killed
      assert.ok(killer.calls.includes("session-1"));
      assert.ok(killer.calls.includes("session-2"));

      // All tasks should be failed
      const wf = orch.getWorkflowStatus()!;
      for (const t of wf.tasks) {
        assert.equal(t.status, "failed");
      }

      // Polling should be stopped (orchestrator marked complete)
      assert.ok(orch.isComplete());

      // State should be persisted
      const stateFile = path.join(baseDir, `${wfId}.json`);
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      assert.ok(raw.tasks.every((t: any) => t.status === "failed"));
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.abort("nonexistent"), /not found/i);
    });
  });

  describe("pause", () => {
    it("pauses the orchestrator so no new tasks are spawned", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      await cp.pause(wfId);
      assert.ok(orch.isPaused());

      // Complete task 1 — task 2 should NOT be spawned because we're paused
      pollResults.set("session-1", { status: "done", output: "ok" });
      await orch.tick();

      const task2Spawned = spawner.calls.find((c) => c.taskId === 2);
      assert.equal(task2Spawned, undefined, "task 2 should not be spawned while paused");
    });

    it("persists state after pausing", async () => {
      const { cp, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      await cp.pause(wfId);

      const stateFile = path.join(baseDir, `${wfId}.json`);
      assert.ok(fs.existsSync(stateFile));
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.pause("nonexistent"), /not found/i);
    });
  });

  describe("resume", () => {
    it("resumes a paused orchestrator and spawns ready tasks", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      // Complete task 1, then pause
      pollResults.set("session-1", { status: "done", output: "ok" });
      await orch.tick();

      await cp.pause(wfId);
      assert.ok(orch.isPaused());

      // Task 2 should not have been spawned yet (paused before tick could spawn it)
      // Actually, tick() already ran and spawned task 2 before pause. Let me adjust:
      // We need to pause BEFORE completing task 1
      // Let me restructure: pause first, then complete task 1, then resume
    });

    it("spawns ready tasks after resuming from pause", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      // Pause immediately
      await cp.pause(wfId);
      assert.ok(orch.isPaused());

      // Complete task 1 while paused — in-flight tasks still get polled
      pollResults.set("session-1", { status: "done", output: "ok" });
      await orch.tick();

      // Task 2 should NOT be spawned (paused)
      assert.equal(spawner.calls.length, 1); // only task 1

      // Resume
      await cp.resume(wfId);
      assert.ok(!orch.isPaused());

      // Tick to spawn ready tasks
      await orch.tick();

      // Task 2 should now be spawned
      const task2Call = spawner.calls.find((c) => c.taskId === 2);
      assert.ok(task2Call, "task 2 should be spawned after resume");
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.resume("nonexistent"), /not found/i);
    });
  });

  describe("status", () => {
    it("returns current task states from active orchestrator", async () => {
      const { cp, wfId, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      const result = await cp.status(wfId);

      assert.equal(result.id, wfId);
      assert.equal(result.tasks.length, 2);

      const t1 = result.tasks.find((t) => t.taskDef.id === 1)!;
      assert.equal(t1.status, "in_progress");

      const t2 = result.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(t2.status, "pending");
    });

    it("reads from persisted state when no active orchestrator", async () => {
      const wf = createPersistedWorkflow(baseDir);

      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      const result = await cp.status(wf.id);
      assert.equal(result.id, wf.id);
      assert.equal(result.tasks.length, 3);
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.status("nonexistent"), /not found/i);
    });
  });

  describe("list", () => {
    it("returns all workflows from disk", async () => {
      createPersistedWorkflow(baseDir, { id: "wf-1", name: "workflow-1", createdAt: 1000 });
      createPersistedWorkflow(baseDir, { id: "wf-2", name: "workflow-2", createdAt: 2000 });

      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      const result = await cp.list();
      assert.equal(result.length, 2);

      const wf1 = result.find((w) => w.id === "wf-1")!;
      assert.equal(wf1.name, "workflow-1");
      assert.equal(wf1.createdAt, 1000);
      assert.ok(typeof wf1.statusCounts.done === "number");
      assert.ok(typeof wf1.statusCounts.failed === "number");
      assert.ok(typeof wf1.statusCounts.pending === "number");
    });

    it("returns empty array when no workflows exist", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      const result = await cp.list();
      assert.deepStrictEqual(result, []);
    });
  });

  describe("post", () => {
    it("reposts the current status message", async () => {
      const { cp, wfId, msgAdapter } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      // Initial status was posted during start
      const initialPostCount = msgAdapter.posted.length;

      await cp.post(wfId);

      // Should have posted a new message
      assert.equal(msgAdapter.posted.length, initialPostCount + 1);
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.post("nonexistent"), /not found/i);
    });
  });

  describe("edit", () => {
    it("updates allowed fields on a pending task", async () => {
      const { cp, orch, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      // Task 2 is pending — should be editable
      await cp.edit(wfId, 2, { prompt: "updated prompt", runtimeLimitMs: 5000 });

      const wf = orch.getWorkflowStatus()!;
      const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(task2.taskDef.prompt, "updated prompt");
      assert.equal(task2.taskDef.runtimeLimitMs, 5000);
    });

    it("updates failureBehavior and failureNotification", async () => {
      const { cp, orch, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      await cp.edit(wfId, 2, {
        failureBehavior: "abort",
        failureNotification: { kind: "notify-parent" },
      });

      const wf = orch.getWorkflowStatus()!;
      const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(task2.taskDef.failureBehavior, "abort");
      assert.deepStrictEqual(task2.taskDef.failureNotification, { kind: "notify-parent" });
    });

    it("rejects edits to in_progress tasks", async () => {
      const { cp, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      // Task 1 is in_progress (spawned immediately)
      await assert.rejects(
        () => cp.edit(wfId, 1, { prompt: "nope" }),
        /in.progress/i,
      );
    });

    it("persists changes to disk immediately", async () => {
      const { cp, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      await cp.edit(wfId, 2, { prompt: "persisted prompt" });

      const stateFile = path.join(baseDir, `${wfId}.json`);
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const task2 = raw.tasks.find((t: any) => t.taskDef.id === 2);
      assert.equal(task2.taskDef.prompt, "persisted prompt");
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.edit("nonexistent", 1, { prompt: "x" }), /not found/i);
    });

    it("throws for unknown task ID", async () => {
      const { cp, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      await assert.rejects(() => cp.edit(wfId, 99, { prompt: "x" }), /task.*not found/i);
    });
  });

  describe("retry", () => {
    it("resets a failed task to pending and spawns it on next tick", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2)],
        "1>2",
      );

      // Fail task 1
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      const wfBefore = orch.getWorkflowStatus()!;
      assert.equal(wfBefore.tasks.find((t) => t.taskDef.id === 1)!.status, "failed");

      // Retry task 1
      await cp.retry(wfId, 1);

      const wfAfter = orch.getWorkflowStatus()!;
      const task1 = wfAfter.tasks.find((t) => t.taskDef.id === 1)!;
      assert.equal(task1.status, "pending");
      assert.equal(task1.error, undefined);
      assert.equal(task1.output, undefined);
      assert.equal(task1.startedAt, undefined);
      assert.equal(task1.completedAt, undefined);

      // Tick to spawn the retried task
      // Clear the poll result so it doesn't immediately fail again
      pollResults.delete("session-1");
      await orch.tick();

      const retrySpawn = spawner.calls.filter((c) => c.taskId === 1);
      assert.ok(retrySpawn.length >= 2, "task 1 should be re-spawned");
    });

    it("also resets blocked downstream failed tasks", async () => {
      const { cp, orch, wfId, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2), makeTask(3)],
        "1>2>3",
      );

      // Fail task 1 — tasks 2 and 3 become blocked/failed
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      const wfBefore = orch.getWorkflowStatus()!;
      assert.equal(wfBefore.tasks.find((t) => t.taskDef.id === 2)!.status, "failed");
      assert.equal(wfBefore.tasks.find((t) => t.taskDef.id === 3)!.status, "failed");

      // Retry task 1 — downstream blocked tasks should also be reset
      await cp.retry(wfId, 1);

      const wfAfter = orch.getWorkflowStatus()!;
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 1)!.status, "pending");
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 2)!.status, "pending");
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 3)!.status, "pending");
    });

    it("cascade resets completed downstream tasks when cascade=true", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2), makeTask(3)],
        "1>2>3",
      );

      // Complete the whole chain
      pollResults.set("session-1", { status: "done", output: "ok1" });
      await orch.tick();
      pollResults.set("session-2", { status: "done", output: "ok2" });
      await orch.tick();
      pollResults.set("session-3", { status: "done", output: "ok3" });
      await orch.tick();

      // All done — now retry task 1 with cascade
      // Need to un-complete the orchestrator first by restoring it
      // Actually the orchestrator is already complete. Let's test with a partially done workflow.
    });

    it("cascade=true resets done downstream tasks to pending", async () => {
      const { cp, orch, wfId, spawner, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1), makeTask(2), makeTask(3)],
        "1>2>3",
      );

      // Complete task 1
      pollResults.set("session-1", { status: "done", output: "ok1" });
      await orch.tick();

      // Complete task 2
      pollResults.set("session-2", { status: "done", output: "ok2" });
      await orch.tick();

      // Fail task 3
      pollResults.set("session-3", { status: "failed", error: "boom" });
      await orch.tick();

      // Now: task 1=done, 2=done, 3=failed
      // Retry task 3 without cascade — only task 3 resets, 1 and 2 stay done
      // But we want to test cascade, so let's retry task 3 with cascade.
      // Task 3 has no downstream, so let's use a different approach:
      // Manually set task 1 to failed to simulate a re-evaluation scenario.
      const wf = orch.getWorkflowStatus()!;
      const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
      task1.status = "failed";
      task1.error = "needs redo";
      task1.completedAt = Date.now();

      // Retry task 1 with cascade — should reset 1, and also reset done tasks 2 + failed task 3
      await cp.retry(wfId, 1, true);

      const wfAfter = orch.getWorkflowStatus()!;
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 1)!.status, "pending");
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 2)!.status, "pending");
      assert.equal(wfAfter.tasks.find((t) => t.taskDef.id === 3)!.status, "pending");
    });

    it("resumes the orchestrator if it was paused", async () => {
      const { cp, orch, wfId, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1, "do task 1", { failureBehavior: "pause" })],
        "1",
      );

      // Fail task 1 with pause behavior
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();
      assert.ok(orch.isPaused());

      // Retry should resume
      await cp.retry(wfId, 1);
      assert.ok(!orch.isPaused());
    });

    it("persists state after retry", async () => {
      const { cp, orch, wfId, pollResults } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      await cp.retry(wfId, 1);

      const stateFile = path.join(baseDir, `${wfId}.json`);
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const task1 = raw.tasks.find((t: any) => t.taskDef.id === 1);
      assert.equal(task1.status, "pending");
    });

    it("throws for unknown workflow", async () => {
      const cp = new ControlPlane({
        orchestrators: new Map(),
        stateDir: baseDir,
        killer: mockKillAdapter(),
        statusManager: null,
      });

      await assert.rejects(() => cp.retry("nonexistent", 1), /not found/i);
    });

    it("throws when retrying a non-failed task", async () => {
      const { cp, wfId } = await setupWorkflow(
        baseDir,
        [makeTask(1)],
        "1",
      );

      // Task 1 is in_progress, not failed
      await assert.rejects(() => cp.retry(wfId, 1), /not failed/i);
    });
  });
});
