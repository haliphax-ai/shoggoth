import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the four fixes/features:
 * 1. Name passthrough (bug)
 * 2. Graph serialization (bug)
 * 3. wait action (feature)
 * 4. Completion notification (feature — tested at daemon adapter level)
 */

// We test via the tool handler since that's the entry point agents use.
import {
  handleFanOutToolCall,
  type FanOutToolArgs,
  type FanOutToolHandlerDeps,
} from "../src/tool-handler.js";
import type { FanOutServer } from "../src/server.js";
import type { ControlPlane } from "../src/control.js";
import type { TaskList, DependencyGraph } from "../src/types.js";

// --- Mocks ---

function mockServer(overrides: Partial<FanOutServer> = {}): FanOutServer {
  return {
    start: async () => "wf-123",
    resume: async () => [],
    get: () => undefined,
    getOrchestrators: () => new Map(),
    stopAll: async () => {},
    ...overrides,
  } as unknown as FanOutServer;
}

function makeWorkflow(overrides: Partial<TaskList> = {}): TaskList {
  const graph: DependencyGraph = new Map([
    [1, new Set<number>()],
    [2, new Set([1])],
    [3, new Set([1, 2])],
  ]);
  return {
    id: "wf-test",
    name: "my-workflow",
    tasks: [
      { taskDef: { id: 1, prompt: "task one", failureBehavior: "continue" as const, failureNotification: "silent" as const }, status: "done" as const, output: "result-1", startedAt: 1000, completedAt: 2000 },
      { taskDef: { id: 2, prompt: "task two", failureBehavior: "continue" as const, failureNotification: "silent" as const }, status: "done" as const, output: "result-2", startedAt: 1000, completedAt: 3000 },
      { taskDef: { id: 3, prompt: "task three", failureBehavior: "continue" as const, failureNotification: "silent" as const }, status: "done" as const, output: "result-3", startedAt: 3000, completedAt: 5000 },
    ],
    graph,
    pollingIntervalMs: 10000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function mockControlPlane(overrides: Partial<Record<string, unknown>> = {}): ControlPlane {
  return {
    abort: async () => {},
    pause: async () => {},
    resume: async () => {},
    status: async () => makeWorkflow(),
    list: async () => [],
    post: async () => {},
    edit: async () => {},
    retry: async () => {},
    retention: async () => ({ prunedIds: [], prunedCount: 0 }),
    wait: async () => makeWorkflow(),
    ...overrides,
  } as unknown as ControlPlane;
}

function makeDeps(overrides: Partial<FanOutToolHandlerDeps> = {}): FanOutToolHandlerDeps {
  return {
    server: mockServer(),
    controlPlane: mockControlPlane(),
    stateDir: "/tmp/fan-out-test",
    currentDepth: 0,
    maxDepth: 2,
    ...overrides,
  };
}

// --- Bug 1: Name passthrough ---

describe("name passthrough", () => {
  it("passes name to server.start", async () => {
    let capturedName: string | undefined;
    const server = mockServer({
      start: async (_tasks, _graph, opts) => {
        capturedName = (opts as unknown as Record<string, unknown>).name as string;
        return "wf-named";
      },
    });
    const deps = makeDeps({ server });
    await handleFanOutToolCall({
      action: "start",
      name: "my-cool-workflow",
      tasks: [{ id: 1, prompt: "do stuff" }],
      graph: "",
      reply_to: "session:parent",
    }, deps);

    assert.equal(capturedName, "my-cool-workflow");
  });

  it("uses default name when not provided", async () => {
    let capturedName: string | undefined;
    const server = mockServer({
      start: async (_tasks, _graph, opts) => {
        capturedName = (opts as unknown as Record<string, unknown>).name as string;
        return "wf-default";
      },
    });
    const deps = makeDeps({ server });
    await handleFanOutToolCall({
      action: "start",
      tasks: [{ id: 1, prompt: "do stuff" }],
      graph: "",
      reply_to: "session:parent",
    }, deps);

    assert.equal(capturedName, "unnamed-workflow");
  });
});

// --- Bug 2: Graph serialization ---

describe("graph serialization in status", () => {
  it("returns graph as a serializable object, not an empty object", async () => {
    const cp = mockControlPlane({
      status: async () => makeWorkflow(),
    });
    const deps = makeDeps({ controlPlane: cp as unknown as ControlPlane });
    const result = await handleFanOutToolCall({ action: "status", workflow_id: "wf-test" }, deps);

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const graph = data.graph as Record<string, number[]>;

    // Graph should be a plain object with task IDs as keys and dep arrays as values
    assert.ok(typeof graph === "object");
    assert.ok(!("size" in graph)); // not a Map
    assert.deepEqual(graph["1"], []);
    assert.deepEqual(graph["2"], [1]);
    assert.deepEqual(graph["3"], [1, 2]);
  });
});

// --- Feature: wait action ---

describe("wait action", () => {
  it("returns completed workflow when all tasks are terminal", async () => {
    const cp = mockControlPlane({
      wait: async () => makeWorkflow(),
    });
    const deps = makeDeps({ controlPlane: cp as unknown as ControlPlane });
    const result = await handleFanOutToolCall({
      action: "wait" as "start", // cast since we're adding it
      workflow_id: "wf-test",
    }, deps);

    assert.equal(result.ok, true);
  });

  it("returns error when workflow_id is missing", async () => {
    const result = await handleFanOutToolCall({
      action: "wait" as "start",
    } as FanOutToolArgs, makeDeps());

    assert.equal(result.ok, false);
    assert.match(result.error!, /workflow_id/);
  });

  it("passes timeout_ms to control plane wait", async () => {
    let capturedTimeout: number | undefined;
    const cp = mockControlPlane({
      wait: async (_wfId: string, timeoutMs?: number) => {
        capturedTimeout = timeoutMs;
        return makeWorkflow();
      },
    });
    const deps = makeDeps({ controlPlane: cp as unknown as ControlPlane });
    await handleFanOutToolCall({
      action: "wait" as "start",
      workflow_id: "wf-test",
      timeout_ms: 30000,
    } as FanOutToolArgs & { timeout_ms: number }, deps);

    assert.equal(capturedTimeout, 30000);
  });
});
