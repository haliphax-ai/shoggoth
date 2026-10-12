import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { loadWorkflow } from "../src/state.js";

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

    const orchestrator = new Orchestrator({ spawner, poller, notifier });

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

    const orchestrator = new Orchestrator({ spawner, poller, notifier });

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
    // The stale-timer tests below create 60s handles — keep them fake.
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
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
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    (orch as any).paused = true;

    orch.restore(makeTaskList(), makeOpts());
    expect(orch.isPaused()).toBe(false);
  });

  it("resets dirty to false", () => {
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    (orch as any).dirty = true;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).dirty).toBe(false);
  });

  it("resets completed to false", () => {
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    (orch as any).completed = true;

    orch.restore(makeTaskList(), makeOpts());
    expect(orch.isComplete()).toBe(false);
  });

  it("clears stale pollingTimer", () => {
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    const fakeTimer = setTimeout(() => {}, 60_000);
    (orch as any).pollingTimer = fakeTimer;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).pollingTimer).toBeNull();
  });

  it("clears stale statusTimer", () => {
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    const fakeTimer = setInterval(() => {}, 60_000);
    (orch as any).statusTimer = fakeTimer;

    orch.restore(makeTaskList(), makeOpts());
    expect((orch as any).statusTimer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — unique task ID validation
// ---------------------------------------------------------------------------

describe("Orchestrator unique task ID validation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-orch-dup-id-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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

  it("throws when two tasks share the same ID", async () => {
    const spawner = makeSpawner([]);
    const poller = makePoller(new Map());
    const notifier = makeNotifier();
    const orch = new Orchestrator({ spawner, poller, notifier });

    const tasks: AgentTaskDef[] = [
      {
        kind: "agent",
        id: 1,
        prompt: "First task",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 1,
        prompt: "Second task with same ID",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
    ];

    await expect(orch.start(tasks, "1", makeOpts())).rejects.toThrow(
      "Duplicate task IDs found: [1]",
    );
  });

  it("throws when multiple IDs are duplicated", async () => {
    const spawner = makeSpawner([]);
    const poller = makePoller(new Map());
    const notifier = makeNotifier();
    const orch = new Orchestrator({ spawner, poller, notifier });

    const tasks: AgentTaskDef[] = [
      {
        kind: "agent",
        id: 1,
        prompt: "A",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 2,
        prompt: "B",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 1,
        prompt: "C",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 2,
        prompt: "D",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
    ];

    await expect(orch.start(tasks, "1>2", makeOpts())).rejects.toThrow(
      /Duplicate task IDs found: \[1, 2\]/,
    );
  });

  it("does not throw when all task IDs are unique", async () => {
    const spawner = makeSpawner([]);
    const poller = makePoller(new Map());
    const notifier = makeNotifier();
    const orch = new Orchestrator({ spawner, poller, notifier });

    const tasks: AgentTaskDef[] = [
      {
        kind: "agent",
        id: 1,
        prompt: "A",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 2,
        prompt: "B",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
      {
        kind: "agent",
        id: 3,
        prompt: "C",
        failureBehavior: "continue",
        failureNotification: "silent",
      },
    ];

    // Should not throw — the graph "1->2" won't include 3, so validateGraph
    // may reject it, but the unique-ID check should pass. We just verify no
    // "Duplicate task IDs" error by catching a different error if any.
    try {
      await orch.start(tasks, "1>2>3", makeOpts());
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Duplicate task IDs/);
    }
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — waitForIdle() drains in-flight background work
// ---------------------------------------------------------------------------

describe("Orchestrator waitForIdle()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-orch-idle-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeOpts(): OrchestratorOptions {
    return {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 3,
      replyTo: "agent:test",
      pollingIntervalMs: 50,
      runtimeLimitMs: 60000,
    };
  }

  function inProgressTask(): AgentTaskDef {
    return {
      kind: "agent",
      id: 1,
      prompt: "do the thing",
      failureBehavior: "continue",
      failureNotification: "silent",
    };
  }

  it("resolves immediately when no background work is in flight", async () => {
    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller: makePoller(new Map()),
      notifier: makeNotifier(),
    });
    await orch.start([inProgressTask()], "1", makeOpts());

    // start() is fully awaited — nothing pending — must not hang.
    await orch.waitForIdle();
  });

  it("waits for an in-flight polling tick fired by fake timers before resolving", async () => {
    vi.useFakeTimers();

    // Poller gated on a manually released promise: once the fake clock fires
    // the polling loop, the tick blocks here with its state persistence
    // still ahead of it — exactly the straggler that used to race rmSync.
    let releasePoll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const poller: PollAdapter = {
      async poll() {
        await gate;
        return { status: "done" as const, output: "ok" };
      },
    };

    const orch = new Orchestrator({
      spawner: makeSpawner([]),
      poller,
      notifier: makeNotifier(),
    });
    const wfId = await orch.start([inProgressTask()], "1", makeOpts());
    orch.startPolling();

    // Fire the polling-loop timer WITHOUT awaiting the async callback —
    // same semantics as a straggler tick under load.
    await vi.advanceTimersByTimeAsync(50);

    // Tear down like the fixed test harness does: cancel future firings,
    // then drain.
    orch.stopPolling();
    let drained = false;
    const idle = orch.waitForIdle().then(() => {
      drained = true;
    });

    // Flush microtasks: the tick is blocked on the gate, so the drain
    // cannot have completed.
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);

    releasePoll();
    await idle;
    expect(drained).toBe(true);

    // The drained tick's saveWorkflow landed: the poll result is persisted.
    const persisted = await loadWorkflow(tempDir, wfId);
    expect(persisted?.tasks[0]?.status).toBe("done");
    expect(persisted?.tasks[0]?.output).toBe("ok");
  });
});
