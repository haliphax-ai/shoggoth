import { describe, it, beforeEach, afterEach } from "vitest";
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
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "../src/orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers (same pattern as other test files)
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-skip-traversal-"));
  fs.chmodSync(dir, 0o777);
  return dir;
}

function makeTask(
  id: number,
  prompt = `do task ${id}`,
  opts: Partial<Pick<TaskDef, "failureBehavior" | "failureNotification" | "runtimeLimitMs">> = {},
): TaskDef {
  return {
    kind: "agent",
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

function mockNotifyAdapter(): NotifyAdapter & {
  calls: Array<{ workflowId: string; success: boolean }>;
} {
  const calls: Array<{ workflowId: string; success: boolean }> = [];
  return {
    calls,
    async notify(workflowId: string, success: boolean): Promise<void> {
      calls.push({ workflowId, success });
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

function getTask(wf: ReturnType<Orchestrator["getWorkflowStatus"]>, id: number) {
  return wf!.tasks.find((t) => t.taskDef.id === id)!;
}

// ---------------------------------------------------------------------------
// Tests for single-pass blocked/skipped traversal
// ---------------------------------------------------------------------------

describe("Single-pass blocked/skipped traversal", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("blocking propagation", () => {
    it("blocks a single direct dependent when a dependency fails", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      await orch.start([makeTask(1), makeTask(2)], "1>2", defaultOpts(baseDir));

      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      assert.equal(getTask(wf, 2).status, "failed");
      assert.match(getTask(wf, 2).error!, /blocked/);
    });

    it("blocks transitive dependents in a chain", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Chain: 1 > 2 > 3 > 4
      await orch.start(
        [makeTask(1), makeTask(2), makeTask(3), makeTask(4)],
        "1>2>3>4",
        defaultOpts(baseDir),
      );

      // Task 1 fails
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      // Tasks 2, 3, and 4 should all be blocked
      for (const id of [2, 3, 4]) {
        assert.equal(getTask(wf, id).status, "failed", `task ${id} should be blocked`);
        assert.match(getTask(wf, id).error!, /blocked/, `task ${id} error should mention blocked`);
      }
    });

    it("blocks diamond dependents when a shared dependency fails", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Diamond: 1,2 > 3 > 4
      await orch.start(
        [makeTask(1), makeTask(2), makeTask(3), makeTask(4)],
        "1,2>3>4",
        defaultOpts(baseDir),
      );

      // Task 1 fails, task 2 succeeds
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      // Task 2 should still be running (independent)
      const wf = orch.getWorkflowStatus()!;
      assert.equal(getTask(wf, 2).status, "in_progress");

      // Now complete task 2
      pollResults.set("session-2", { status: "done", output: "ok" });
      await orch.tick();

      // Task 3 depends on 1 (failed) and 2 (done) — should be blocked
      assert.equal(getTask(wf, 3).status, "failed");
      assert.match(getTask(wf, 3).error!, /blocked/);

      // Task 4 depends on 3 (blocked) — should also be blocked
      assert.equal(getTask(wf, 4).status, "failed");
      assert.match(getTask(wf, 4).error!, /blocked/);
    });

    it("does not block tasks on independent branches", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Independent branches: 1>3 and 2>4
      await orch.start(
        [makeTask(1), makeTask(2), makeTask(3), makeTask(4)],
        "1>3 2>4",
        defaultOpts(baseDir),
      );

      // Task 1 fails
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      // Task 3 should be blocked (dep 1 failed)
      assert.equal(getTask(orch.getWorkflowStatus()!, 3).status, "failed");

      // Task 2 should still be in_progress, task 4 should still be waiting
      assert.equal(getTask(orch.getWorkflowStatus()!, 2).status, "in_progress");
      assert.equal(getTask(orch.getWorkflowStatus()!, 4).status, "pending");

      // Complete task 2 successfully
      pollResults.set("session-2", { status: "done", output: "ok" });
      await orch.tick();

      // Task 4 should now be spawned (its branch is clean)
      assert.equal(getTask(orch.getWorkflowStatus()!, 4).status, "in_progress");
    });
  });

  describe("skip propagation", () => {
    it("skips a dependent when a dependency is skipped", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Task 1 is a gate that will fail (so it won't be spawned by the orchestrator)
      // Instead, we simulate the skip by directly failing task 1 then using a gate
      // Actually, let's just use the fact that task 1 is a gate that evaluates to false.
      // But for simplicity, let's test via the control plane: we can set a task to skipped
      // by using a gate task.

      // Let's use a simpler approach: we'll use two branches where one has a gate
      // Actually, the simplest approach is to test through the tick cycle where a gate
      // evaluates to false.

      // Gate task 1 that evaluates to false → task 2 depends on it
      const tasks: TaskDef[] = [
        {
          kind: "gate",
          id: 1,
          condition: "false",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        makeTask(2),
      ];

      await orch.start(tasks, "1>2", defaultOpts(baseDir));

      // Tick to evaluate the gate
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      // Gate evaluated to false → task 1 is done with output "skip"
      assert.equal(getTask(wf, 1).status, "done");
      assert.equal(getTask(wf, 1).output, "skip");

      // Task 2 should be skipped because its dependency (gate) evaluated to false
      assert.equal(getTask(wf, 2).status, "skipped");
    });

    it("propagates skip transitively through a chain", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Gate 1 (false) > 2 > 3
      const tasks: TaskDef[] = [
        {
          kind: "gate",
          id: 1,
          condition: "false",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        makeTask(2),
        makeTask(3),
      ];

      await orch.start(tasks, "1>2>3", defaultOpts(baseDir));
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      assert.equal(getTask(wf, 1).status, "done"); // gate evaluated to false
      assert.equal(getTask(wf, 2).status, "skipped");
      assert.equal(getTask(wf, 3).status, "skipped");
    });
  });

  describe("skip takes priority over block", () => {
    it("marks task as skipped (not blocked) when a dependency is both skipped and another failed", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Gate 1 (false) and task 2 both feed into task 3
      // Task 2 fails, gate 1 evaluates to false (skip)
      const tasks: TaskDef[] = [
        {
          kind: "gate",
          id: 1,
          condition: "false",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        makeTask(2),
        makeTask(3),
      ];

      await orch.start(tasks, "1,2>3", defaultOpts(baseDir));

      // Task 2 fails
      pollResults.set("session-2", { status: "failed", error: "boom" });
      // Tick: gate evaluates to false, task 2 fails
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;
      // Task 3 has deps: gate (skipped via output=skip) and task 2 (failed)
      // Skip should take priority over block
      assert.equal(getTask(wf, 3).status, "skipped");
    });
  });

  describe("missing dependency handling", () => {
    it("does not block root tasks with no dependencies", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Independent root tasks
      const tasks = [makeTask(1), makeTask(2)];
      await orch.start(tasks, "1 2", defaultOpts(baseDir));

      // Both tasks should be spawned immediately (they are root tasks)
      assert.equal(spawner.calls.length, 2);

      // Complete task 1
      pollResults.set("session-1", { status: "done", output: "ok" });
      await orch.tick();

      // Task 2 should still be running (independent)
      assert.equal(getTask(orch.getWorkflowStatus()!, 2).status, "in_progress");
    });
  });

  describe("mixed scenarios", () => {
    it("handles a complex graph with both failures and skips", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Complex graph:
      //   Gate 1 (false) → 3 → 5
      //   Task 2 (fails) → 4
      //   Task 3 also depends on Task 2
      //
      // 1,2>3 2>4 3>5
      const tasks: TaskDef[] = [
        {
          kind: "gate",
          id: 1,
          condition: "false",
          failureBehavior: "continue",
          failureNotification: "silent",
        },
        makeTask(2),
        makeTask(3),
        makeTask(4),
        makeTask(5),
      ];

      await orch.start(tasks, "1,2>3 2>4 3>5", defaultOpts(baseDir));

      // Task 2 fails
      pollResults.set("session-2", { status: "failed", error: "boom" });
      // Tick: gate evaluates to false, task 2 fails
      await orch.tick();

      const wf = orch.getWorkflowStatus()!;

      // Gate 1 → done (output=skip)
      assert.equal(getTask(wf, 1).status, "done");
      assert.equal(getTask(wf, 1).output, "skip");

      // Task 3 depends on gate 1 (skip) and task 2 (failed) → skip takes priority
      assert.equal(getTask(wf, 3).status, "skipped");

      // Task 4 depends on task 2 (failed) → blocked
      assert.equal(getTask(wf, 4).status, "failed");
      assert.match(getTask(wf, 4).error!, /blocked/);

      // Task 5 depends on task 3 (skipped) → skipped
      assert.equal(getTask(wf, 5).status, "skipped");
    });

    it("handles all tasks succeeding after initial failure + retry", async () => {
      const spawner = mockSpawnAdapter();
      const pollResults = new Map<string, PollResult>();
      const poller = mockPollAdapter(pollResults);
      const notifier = mockNotifyAdapter();
      const orch = new Orchestrator({ spawner, poller, notifier });

      // Chain: 1 > 2 > 3
      await orch.start(
        [makeTask(1, "do task 1", { failureBehavior: "pause" }), makeTask(2), makeTask(3)],
        "1>2>3",
        defaultOpts(baseDir),
      );

      // Task 1 fails
      pollResults.set("session-1", { status: "failed", error: "boom" });
      await orch.tick();

      // Tasks 2 and 3 are blocked, orchestrator is paused
      assert.equal(getTask(orch.getWorkflowStatus()!, 2).status, "failed");
      assert.equal(getTask(orch.getWorkflowStatus()!, 3).status, "failed");
      assert.ok(orch.isPaused());

      // Retry task 1 via control plane (properly resets task and unblocks downstream)
      const { ControlPlane } = await import("../src/control.js");
      const cp = new ControlPlane({
        orchestrators: new Map([[orch.getWorkflowStatus()!.id, orch]]),
        stateDir: baseDir,
        killer: { async kill() {} },
      });
      await cp.retry(orch.getWorkflowStatus()!.id, 1);

      // Orchestrator should be unpaused
      assert.ok(!orch.isPaused());

      // Tick to re-spawn task 1
      pollResults.delete("session-1");
      await orch.tick();

      // Complete task 1
      pollResults.set("session-1", { status: "done", output: "ok" });
      await orch.tick();

      // Task 2 should be spawned
      assert.equal(getTask(orch.getWorkflowStatus()!, 2).status, "in_progress");

      // Complete task 2
      pollResults.set("session-2", { status: "done", output: "ok" });
      await orch.tick();

      // Task 3 should be spawned
      assert.equal(getTask(orch.getWorkflowStatus()!, 3).status, "in_progress");

      // Complete task 3
      pollResults.set("session-3", { status: "done", output: "ok" });
      await orch.tick();

      assert.ok(orch.isComplete());
      assert.ok(orch.getWorkflowStatus()!.tasks.every((t) => t.status === "done"));
    });
  });
});
