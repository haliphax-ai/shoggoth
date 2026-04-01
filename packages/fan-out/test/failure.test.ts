import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef } from "../src/types.js";
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

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-failure-test-"));
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

function mockSpawnAdapter(): SpawnAdapter & { calls: SpawnRequest[]; shouldThrow?: Error } {
  const calls: SpawnRequest[] = [];
  return {
    calls,
    shouldThrow: undefined,
    async spawn(req: SpawnRequest): Promise<string> {
      if (this.shouldThrow) throw this.shouldThrow;
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

describe("Failure Handling", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe("abort behavior", () => {
    it("kills all active tasks and fails the entire workflow", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Tasks 1 and 2 are independent roots, 3 depends on both
      // Task 1 has abort behavior
      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "abort" }),
        makeTask(2, "do task 2"),
        makeTask(3, "do task 3"),
      ];
      const graphDsl = "1,2>3";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      // Both 1 and 2 should be spawned
      assert.equal(spawner.calls.length, 2);

      // Task 1 fails
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      // Task 2 should have been killed
      assert.ok(killer.calls.includes("session-2"));

      // All tasks should be terminal
      const wf = orch.getWorkflowStatus()!;
      assert.ok(wf.tasks.every((t) => t.status === "failed" || t.status === "done"));

      // Task 2 should be failed (killed by abort)
      const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(task2.status, "failed");

      // Task 3 should be failed (pending, aborted)
      const task3 = wf.tasks.find((t) => t.taskDef.id === 3)!;
      assert.equal(task3.status, "failed");

      // Workflow should be complete
      assert.ok(orch.isComplete());
    });
  });

  describe("pause behavior", () => {
    it("pauses the orchestrator but lets in-flight tasks finish", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // 1 and 2 are roots, 3 depends on both
      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "pause" }),
        makeTask(2, "do task 2"),
        makeTask(3, "do task 3"),
      ];
      const graphDsl = "1,2>3";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      // Task 1 fails → should pause
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      assert.ok(orch.isPaused());

      // Task 2 completes — should still be processed even while paused
      pollResults.set("session-2", { status: "done", output: "ok" });
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(task2.status, "done");

      // Task 3 should NOT have been spawned (paused)
      const task3 = wf.tasks.find((t) => t.taskDef.id === 3)!;
      assert.equal(task3.status, "pending");

      // Workflow should NOT be complete (paused, task 3 still pending)
      assert.ok(!orch.isComplete());
    });
  });

  describe("continue behavior", () => {
    it("marks failed task and continues independent branches", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Two independent branches: 1>3 and 2>4
      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "continue" }),
        makeTask(2, "do task 2"),
        makeTask(3, "do task 3"),
        makeTask(4, "do task 4"),
      ];
      const graphDsl = "1>3 2>4";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      // Tasks 1 and 2 spawned
      assert.equal(spawner.calls.length, 2);

      // Task 1 fails, task 2 succeeds
      pollResults.set("session-1", { status: "failed", error: "boom" });
      pollResults.set("session-2", { status: "done", output: "ok" });
      await orch.tick();

      // Task 3 should be blocked (dep 1 failed), task 4 should be spawned
      const wf = orch.getWorkflowStatus()!;
      const task3 = wf.tasks.find((t) => t.taskDef.id === 3)!;
      assert.equal(task3.status, "failed");
      assert.match(task3.error!, /blocked/);

      const task4spawn = spawner.calls.find((c) => c.taskId === 4);
      assert.ok(task4spawn, "task 4 should have been spawned");
    });

    it("blocks downstream tasks that depend on the failed task", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator(spawner, poller, notifier);

      // Chain: 1 > 2 > 3
      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "continue" }),
        makeTask(2, "do task 2"),
        makeTask(3, "do task 3"),
      ];
      const graphDsl = "1>2>3";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      // Both 2 and 3 should be failed (blocked)
      for (const id of [2, 3]) {
        const t = wf.tasks.find((t) => t.taskDef.id === id)!;
        assert.equal(t.status, "failed");
      }

      assert.ok(orch.isComplete());
    });
  });

  describe("failure notification routing", () => {
    it("sends no notification for silent", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      const tasks = [makeTask(1, "do task 1", { failureNotification: "silent" })];
      await orch.start(tasks, "1", defaultOpts(baseDir));

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      assert.equal(notifications.calls.length, 0);
    });

    it("notifies parent for notify-parent", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      const tasks = [
        makeTask(1, "do task 1", { failureNotification: { kind: "notify-parent" } }),
      ];
      const opts = defaultOpts(baseDir);
      await orch.start(tasks, "1", opts);

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      assert.equal(notifications.calls.length, 1);
      assert.equal(notifications.calls[0].target, opts.replyTo);
      assert.ok(notifications.calls[0].message.includes("boom"));
      assert.ok(notifications.calls[0].message.includes("1"));
    });

    it("notifies specific target for notify-target", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      const tasks = [
        makeTask(1, "do task 1", {
          failureNotification: { kind: "notify-target", targetId: "agent:ops" },
        }),
      ];
      await orch.start(tasks, "1", defaultOpts(baseDir));

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      assert.equal(notifications.calls.length, 1);
      assert.equal(notifications.calls[0].target, "agent:ops");
    });
  });

  describe("spawn error handling", () => {
    it("pauses orchestrator and marks task as failed on spawn error", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Two independent tasks
      const tasks = [makeTask(1), makeTask(2)];
      const graphDsl = "1 2";

      // Make spawn fail
      spawner.shouldThrow = new Error("spawn failed: no capacity");

      const opts = defaultOpts(baseDir);
      await orch.start(tasks, graphDsl, opts);

      // Orchestrator should be paused
      assert.ok(orch.isPaused());

      // The first task that failed to spawn should be marked failed
      const wf = orch.getWorkflowStatus()!;
      const failedTasks = wf.tasks.filter((t) => t.status === "failed");
      assert.ok(failedTasks.length >= 1);
      assert.ok(failedTasks[0].error!.includes("spawn failed"));

      // Parent should be notified
      assert.ok(notifications.calls.length >= 1);
      assert.equal(notifications.calls[0].target, opts.replyTo);
    });

    it("pauses orchestrator on spawn error during tick", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      const tasks = [makeTask(1), makeTask(2)];
      const graphDsl = "1>2";
      const opts = defaultOpts(baseDir);
      await orch.start(tasks, graphDsl, opts);

      // Task 1 completes
      pollResults.set("session-1", { status: "done", output: "ok" });

      // Make spawn fail for task 2
      spawner.shouldThrow = new Error("spawn failed: timeout");
      await orch.tick();

      assert.ok(orch.isPaused());

      const wf = orch.getWorkflowStatus()!;
      const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
      assert.equal(task2.status, "failed");
      assert.ok(task2.error!.includes("spawn failed"));
    });
  });

  describe("runtime limit enforcement", () => {
    it("kills tasks that exceed their runtime limit", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Task with a very short runtime limit
      const tasks = [makeTask(1, "do task 1", { runtimeLimitMs: 1 })];
      await orch.start(tasks, "1", defaultOpts(baseDir));

      // Wait a tiny bit so the limit is exceeded
      await new Promise((r) => setTimeout(r, 10));

      // Task is still "running" from the poller's perspective
      pollResults.set("session-1", { status: "running" });
      await orch.tick();

      // Should have been killed
      assert.ok(killer.calls.includes("session-1"));

      const wf = orch.getWorkflowStatus()!;
      const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
      assert.equal(task1.status, "failed");
      assert.ok(task1.error!.includes("timeout"));
    });

    it("uses default runtime limit when task has none", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Task with no runtimeLimitMs — uses default (600_000)
      const tasks = [makeTask(1)];
      await orch.start(tasks, "1", defaultOpts(baseDir));

      pollResults.set("session-1", { status: "running" });
      await orch.tick();

      // Should NOT have been killed (default is 10 minutes)
      assert.equal(killer.calls.length, 0);
    });

    it("applies failure behavior after timeout kill", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      // Task 1 has abort behavior and short timeout, task 2 is independent
      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "abort", runtimeLimitMs: 1 }),
        makeTask(2, "do task 2"),
      ];
      const graphDsl = "1 2";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      await new Promise((r) => setTimeout(r, 10));

      pollResults.set("session-1", { status: "running" });
      pollResults.set("session-2", { status: "running" });
      await orch.tick();

      // Task 1 timed out with abort → task 2 should also be killed
      assert.ok(killer.calls.includes("session-1"));
      assert.ok(killer.calls.includes("session-2"));

      const wf = orch.getWorkflowStatus()!;
      assert.ok(wf.tasks.every((t) => t.status === "failed"));
      assert.ok(orch.isComplete());
    });

    it("sends failure notification after timeout", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const notifications = mockNotificationAdapter();
      const killer = mockKillAdapter();
      const orch = new Orchestrator(spawner, poller, notifier, undefined, notifications, killer);

      const tasks = [
        makeTask(1, "do task 1", {
          runtimeLimitMs: 1,
          failureNotification: { kind: "notify-parent" },
        }),
      ];
      const opts = defaultOpts(baseDir);
      await orch.start(tasks, "1", opts);

      await new Promise((r) => setTimeout(r, 10));

      pollResults.set("session-1", { status: "running" });
      await orch.tick();

      assert.equal(notifications.calls.length, 1);
      assert.equal(notifications.calls[0].target, opts.replyTo);
      assert.ok(notifications.calls[0].message.includes("timeout"));
    });
  });

  describe("state persistence", () => {
    it("persists state after failure handling", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator(spawner, poller, notifier);

      const tasks = [
        makeTask(1, "do task 1", { failureBehavior: "abort" }),
        makeTask(2, "do task 2"),
      ];
      const graphDsl = "1 2";
      await orch.start(tasks, graphDsl, defaultOpts(baseDir));

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      // Read persisted state
      const wfId = orch.getWorkflowStatus()!.id;
      const stateFile = path.join(baseDir, `${wfId}.json`);
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

      // All tasks should be failed in persisted state
      assert.ok(raw.tasks.every((t: any) => t.status === "failed"));
    });
  });
});
