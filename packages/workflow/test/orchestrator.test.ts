import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  SpawnRequest,
  SpawnAdapter,
  PollAdapter,
  NotifyAdapter,
  OrchestratorOptions,
} from "../src/orchestrator.js";
import type { TaskList } from "../src/types.js";
import type { AgentTaskDef } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawner(capturedRequests: SpawnRequest[]): SpawnAdapter {
  let counter = 0;
  return {
    async spawn(req: SpawnRequest): Promise<string> {
      capturedRequests.push(req);
      return `session-${++counter}`;
    },
    abortTask() {},
  };
}

function makePoller(
  results: Map<string, { status: "running" | "done" | "failed"; output?: string }>,
): PollAdapter {
  return {
    async poll(sessionKey: string) {
      return results.get(sessionKey) ?? { status: "running" };
    },
  };
}

function makeNotifier(): NotifyAdapter {
  return { async notify() {} };
}

// ---------------------------------------------------------------------------
// Orchestrator — SpawnRequest includes responseSchema
// ---------------------------------------------------------------------------

describe("Orchestrator SpawnRequest responseSchema", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-orch-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes responseSchema through SpawnRequest when spawning an agent task", async () => {
    const capturedRequests: SpawnRequest[] = [];
    const pollResults = new Map<
      string,
      { status: "running" | "done" | "failed"; output?: string }
    >();

    const spawner = makeSpawner(capturedRequests);
    const poller = makePoller(pollResults);
    const notifier = makeNotifier();

    const orchestrator = new Orchestrator(spawner, poller, notifier);

    const responseSchema = {
      schema: {
        type: "object",
        properties: {
          total_errors: { type: "number" },
          categories: { type: "array" },
        },
        required: ["total_errors", "categories"],
        additionalProperties: false,
      },
    };

    const taskDef: AgentTaskDef = {
      kind: "agent",
      id: 1,
      prompt: "Analyze the error logs",
      failureBehavior: "continue",
      failureNotification: "silent",
      responseSchema,
    };

    await orchestrator.start([taskDef], "1", {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 3,
      replyTo: "agent:test",
      pollingIntervalMs: 1000,
      runtimeLimitMs: 60000,
    });

    // The spawner should have been called with the task
    expect(capturedRequests).toHaveLength(1);

    // The SpawnRequest should include responseSchema — this will FAIL
    // because the orchestrator doesn't pass responseSchema to the spawn request yet
    const req = capturedRequests[0];
    expect(req.responseSchema).toBeDefined();
    expect(req.responseSchema).toEqual(responseSchema);
  });

  it("does not include responseSchema in SpawnRequest when task has none", async () => {
    const capturedRequests: SpawnRequest[] = [];
    const pollResults = new Map<
      string,
      { status: "running" | "done" | "failed"; output?: string }
    >();

    const spawner = makeSpawner(capturedRequests);
    const poller = makePoller(pollResults);
    const notifier = makeNotifier();

    const orchestrator = new Orchestrator(spawner, poller, notifier);

    const taskDef: AgentTaskDef = {
      kind: "agent",
      id: 1,
      prompt: "Simple task without schema",
      failureBehavior: "continue",
      failureNotification: "silent",
    };

    await orchestrator.start([taskDef], "1", {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 3,
      replyTo: "agent:test",
      pollingIntervalMs: 1000,
      runtimeLimitMs: 60000,
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].responseSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — restore() resets stale state
// ---------------------------------------------------------------------------

describe("Orchestrator restore()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-orch-restore-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTaskList(): TaskList {
    return {
      id: "wf-restore-test",
      name: "restore-test",
      tasks: [],
      graph: new Map(),
      pollingIntervalMs: 1000,
      createdAt: Date.now(),
    };
  }

  function makeOpts(): OrchestratorOptions {
    return {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 3,
      replyTo: "agent:test",
      pollingIntervalMs: 1000,
      runtimeLimitMs: 60000,
    };
  }

  it("resets paused to false", () => {
    const orch = new Orchestrator(makeSpawner([]), makePoller(new Map()), makeNotifier());
    (orch as any).paused = true;

    orch.restore(makeTaskList(), makeOpts());
    expect(orch.isPaused()).toBe(false);
  });

  it("resets dirty to false", () => {
    const orch = new Orchestrator(makeSpawner([]), makePoller(new Map()), makeNotifier());
    (orch as any).dirty = true;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).dirty).toBe(false);
  });

  it("resets completed to false", () => {
    const orch = new Orchestrator(makeSpawner([]), makePoller(new Map()), makeNotifier());
    (orch as any).completed = true;

    orch.restore(makeTaskList(), makeOpts());
    expect(orch.isComplete()).toBe(false);
  });

  it("clears stale pollingTimer", () => {
    const orch = new Orchestrator(makeSpawner([]), makePoller(new Map()), makeNotifier());
    const fakeTimer = setTimeout(() => {}, 60_000);
    (orch as any).pollingTimer = fakeTimer;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).pollingTimer).toBeNull();
  });

  it("clears stale statusTimer", () => {
    const orch = new Orchestrator(makeSpawner([]), makePoller(new Map()), makeNotifier());
    const fakeTimer = setInterval(() => {}, 60_000);
    (orch as any).statusTimer = fakeTimer;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).statusTimer).toBeNull();
  });
});
