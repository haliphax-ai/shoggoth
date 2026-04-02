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

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fanout-conc-test-"));
}

function makeTask(id: number, prompt = `do task ${id}`): TaskDef {
  return {
    id,
    prompt,
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

function defaultOpts(baseDir: string, concurrency?: number): OrchestratorOptions {
  return {
    stateDir: baseDir,
    currentDepth: 0,
    maxDepth: 2,
    replyTo: "agent:parent",
    pollingIntervalMs: 50,
    runtimeLimitMs: 60_000,
    concurrency,
  };
}

describe("Orchestrator concurrency", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("concurrency=2 only allows 2 tasks in_progress at once", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    // 4 independent tasks, all roots
    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)];
    const graphDsl = "1 2 3 4";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, 2));

    // Only 2 should be spawned initially
    assert.equal(spawner.calls.length, 2);

    const status = orch.getWorkflowStatus()!;
    const inProgress = status.tasks.filter((t) => t.status === "in_progress").length;
    assert.equal(inProgress, 2);

    const pending = status.tasks.filter((t) => t.status === "pending").length;
    assert.equal(pending, 2);
  });

  it("spawns waiting tasks when a slot opens up", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)];
    const graphDsl = "1 2 3 4";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, 2));

    // 2 spawned initially
    assert.equal(spawner.calls.length, 2);
    const firstTwo = spawner.calls.map((c) => c.taskId);

    // Complete the first spawned task
    pollResults.set(`session-${firstTwo[0]}`, { status: "done", output: "ok" });
    await orch.tick();

    // One slot opened, so one more task should be spawned (total 3)
    assert.equal(spawner.calls.length, 3);

    // Complete the second initial task
    pollResults.set(`session-${firstTwo[1]}`, { status: "done", output: "ok" });
    await orch.tick();

    // Another slot opened, last task should be spawned (total 4)
    assert.equal(spawner.calls.length, 4);
  });

  it("concurrency=undefined means unlimited parallelism", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)];
    const graphDsl = "1 2 3 4";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, undefined));

    // All 4 should be spawned immediately
    assert.equal(spawner.calls.length, 4);
  });

  it("concurrency=0 means unlimited parallelism", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)];
    const graphDsl = "1 2 3 4";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, 0));

    // All 4 should be spawned immediately
    assert.equal(spawner.calls.length, 4);
  });

  it("concurrency interacts correctly with dependency graph", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    // 1 and 2 are roots, 3 depends on 1, 4 depends on 2
    const tasks = [makeTask(1), makeTask(2), makeTask(3), makeTask(4)];
    const graphDsl = "1>3 2>4";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, 1));

    // Only 1 task should be spawned (concurrency=1)
    assert.equal(spawner.calls.length, 1);

    // Complete it
    const firstId = spawner.calls[0].taskId;
    pollResults.set(`session-${firstId}`, { status: "done", output: "ok" });
    await orch.tick();

    // Now one more should be spawned (either the other root or the downstream)
    assert.equal(spawner.calls.length, 2);
  });

  it("failed tasks free concurrency slots", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeTask(1), makeTask(2), makeTask(3)];
    const graphDsl = "1 2 3";
    await orch.start(tasks, graphDsl, defaultOpts(baseDir, 2));

    assert.equal(spawner.calls.length, 2);
    const firstId = spawner.calls[0].taskId;

    // Fail the first task
    pollResults.set(`session-${firstId}`, { status: "failed", error: "boom" });
    await orch.tick();

    // Slot freed, third task should be spawned
    assert.equal(spawner.calls.length, 3);
  });

  it("concurrency is persisted in workflow state", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const orch = new Orchestrator(spawner, poller, notifier);

    const tasks = [makeTask(1), makeTask(2)];
    const graphDsl = "1 2";
    const wfId = await orch.start(tasks, graphDsl, defaultOpts(baseDir, 3));

    const stateFile = path.join(baseDir, `${wfId}.json`);
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.equal(raw.concurrency, 3);
  });
});
