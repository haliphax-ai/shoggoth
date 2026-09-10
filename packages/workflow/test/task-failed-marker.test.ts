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
  type NotificationAdapter,
  type KillAdapter,
  type SpawnRequest,
  type PollResult,
  type OrchestratorOptions,
} from "../src/orchestrator.js";

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-failed-marker-test-"));
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

function mockNotificationAdapter(): NotificationAdapter & {
  calls: Array<{ target: string; message: string }>;
} {
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

describe("ERROR:TASK_FAILED marker detection", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("marks task as failed when output contains ERROR:TASK_FAILED at the end", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1)];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    // Subagent "completes" but includes the failure marker at the end
    pollResults.set("session-1", {
      status: "done",
      output: "I tried to do the task but couldn't find the file.\nERROR:TASK_FAILED",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
  });

  it("marks task as failed when output contains ERROR:TASK_FAILED at the beginning", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1)];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    pollResults.set("session-1", {
      status: "done",
      output: "ERROR:TASK_FAILED\nI was unable to complete the task.",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
  });

  it("marks task as failed when output contains ERROR:TASK_FAILED in the middle", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1)];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    pollResults.set("session-1", {
      status: "done",
      output: "Some preamble text.\nERROR:TASK_FAILED\nSome trailing text.",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
  });

  it("preserves the full subagent response text as the error message", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1)];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    const fullResponse = "I tried but the API returned 403 Forbidden.\nERROR:TASK_FAILED";
    pollResults.set("session-1", {
      status: "done",
      output: fullResponse,
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");
    // The error should contain the full subagent response text
    assert.ok(task1.error!.includes("I tried but the API returned 403 Forbidden."));
  });

  it("does not mark task as failed when output does not contain the marker", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1)];
    await orch.start(tasks, "1", defaultOpts(baseDir));

    pollResults.set("session-1", {
      status: "done",
      output: "Task completed successfully. All files updated.",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "done");
    assert.equal(task1.output, "Task completed successfully. All files updated.");
  });

  it("is case-sensitive — does not match lowercase or mixed case variants", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    const tasks = [makeTask(1), makeTask(2), makeTask(3)];
    await orch.start(tasks, "1 2 3", defaultOpts(baseDir));

    // lowercase
    pollResults.set("session-1", {
      status: "done",
      output: "error:task_failed",
    });
    // mixed case
    pollResults.set("session-2", {
      status: "done",
      output: "Error:Task_Failed",
    });
    // partial match
    pollResults.set("session-3", {
      status: "done",
      output: "ERROR:TASK_FAILED_PARTIALLY",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    // lowercase should NOT trigger failure
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "done");

    // mixed case should NOT trigger failure
    const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
    assert.equal(task2.status, "done");

    // Note: partial match like "ERROR:TASK_FAILED_PARTIALLY" DOES contain "ERROR:TASK_FAILED"
    // so it WILL trigger failure — this is by design (substring match)
    const task3 = wf.tasks.find((t) => t.taskDef.id === 3)!;
    assert.equal(task3.status, "failed");
  });

  it("forwards the full response text in failure notification to parent", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const notifications = mockNotificationAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, notifications, killer });

    const tasks = [
      makeTask(1, "do task 1", {
        failureNotification: { kind: "notify-parent" },
      }),
    ];
    const opts = defaultOpts(baseDir);
    await orch.start(tasks, "1", opts);

    const fullResponse = "Could not complete: missing credentials for the API.\nERROR:TASK_FAILED";
    pollResults.set("session-1", {
      status: "done",
      output: fullResponse,
    });
    await orch.tick();

    // Should have sent a failure notification
    assert.equal(notifications.calls.length, 1);
    assert.equal(notifications.calls[0].target, opts.replyTo);
    // The notification message should reference the task failure
    assert.ok(notifications.calls[0].message.includes("failed"));
  });

  it("blocks downstream tasks when a task self-reports failure via marker", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    // Chain: 1 > 2
    const tasks = [makeTask(1), makeTask(2)];
    await orch.start(tasks, "1>2", defaultOpts(baseDir));

    // Task 1 self-reports failure
    pollResults.set("session-1", {
      status: "done",
      output: "Something went wrong.\nERROR:TASK_FAILED",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    const task1 = wf.tasks.find((t) => t.taskDef.id === 1)!;
    assert.equal(task1.status, "failed");

    // Task 2 should be blocked since its dependency failed
    const task2 = wf.tasks.find((t) => t.taskDef.id === 2)!;
    assert.equal(task2.status, "failed");
    assert.ok(task2.error!.includes("blocked"));
  });

  it("triggers abort behavior when marker-failed task has failureBehavior=abort", async () => {
    const spawner = mockSpawnAdapter();
    const pollResults = new Map<string, PollResult>();
    const poller = mockPollAdapter(pollResults);
    const notifier = mockNotifyAdapter();
    const killer = mockKillAdapter();
    const orch = new Orchestrator({ spawner, poller, notifier, killer });

    // Task 1 has abort behavior, task 2 is independent
    const tasks = [
      makeTask(1, "do task 1", { failureBehavior: "abort" }),
      makeTask(2, "do task 2"),
    ];
    await orch.start(tasks, "1 2", defaultOpts(baseDir));

    // Task 1 self-reports failure via marker
    pollResults.set("session-1", {
      status: "done",
      output: "Cannot proceed.\nERROR:TASK_FAILED",
    });
    await orch.tick();

    const wf = orch.getWorkflowStatus()!;
    // Both tasks should be failed (abort kills everything)
    assert.ok(wf.tasks.every((t) => t.status === "failed"));
    assert.ok(orch.isComplete());
  });
});
