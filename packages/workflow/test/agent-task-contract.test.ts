/**
 * Contract mode for workflow agent tasks:
 * - tool-handler parses/validates `contract` and `judge` into AgentTaskDef
 * - the orchestrator forwards them to the spawn adapter
 */

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { handleWorkflowToolCall } from "../src/tool-handler.js";
import type { WorkflowServer } from "../src/server.js";
import type { ControlPlane } from "../src/control.js";
import type { WorkflowToolHandlerDeps, WorkflowToolArgs } from "../src/tool-handler.js";
import type { TaskList, AgentTaskDef } from "../src/types.js";
import os from "node:os";

function mockServer(overrides: Partial<WorkflowServer> = {}): WorkflowServer {
  return {
    start: async () => "wf-123",
    resume: async () => [],
    get: () => undefined,
    stopAll: async () => {},
    ...overrides,
  } as unknown as WorkflowServer;
}

function mockControlPlane(): ControlPlane {
  return {
    abort: async () => {},
    pause: async () => {},
    resume: async () => {},
    status: async () =>
      ({
        id: "wf-123",
        name: "test",
        tasks: [],
        graph: new Map(),
        pollingIntervalMs: 10000,
        createdAt: Date.now(),
      }) as TaskList,
    list: async () => [],
    post: async () => {},
    edit: async () => {},
    retry: async () => {},
    retention: async () => ({ prunedIds: [], prunedCount: 0 }),
    wait: async () =>
      ({
        id: "wf-123",
        name: "test",
        tasks: [],
        graph: new Map(),
        pollingIntervalMs: 10000,
        createdAt: Date.now(),
      }) as TaskList,
  } as unknown as ControlPlane;
}

function makeDeps(server: WorkflowServer): WorkflowToolHandlerDeps {
  return {
    server,
    controlPlane: mockControlPlane(),
    stateDir: "/tmp/workflow-test",
    currentDepth: 0,
    maxDepth: 2,
    workspaceRoot: os.tmpdir(),
  };
}

const contract = [
  { path: "src/a.ts", action: "create" as const, summary: "add module" },
  { path: "README.md", action: "update" as const, summary: "document it" },
];

async function startAndCapture(
  tasks: NonNullable<WorkflowToolArgs["tasks"]>,
): Promise<AgentTaskDef[]> {
  let captured: unknown;
  const server = mockServer({
    start: async (defs) => {
      captured = defs;
      return "wf-contract";
    },
  });
  const result = await handleWorkflowToolCall(
    {
      action: "start",
      name: "contract-wf",
      graph: "1",
      tasks,
      reply_to: "session:parent",
    },
    makeDeps(server),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return (captured as AgentTaskDef[]) ?? [];
}

describe("workflow contract mode", () => {
  it("parses contract and judge into the agent task def", async () => {
    const defs = await startAndCapture([
      { id: 1, prompt: "do it", contract, judge: "typesafe-main/jev-latest" },
    ]);
    const task = defs[0];
    assert.deepEqual(task.contract, contract);
    assert.equal(task.judge, "typesafe-main/jev-latest");
  });

  it("leaves contract unset when absent (mode inactive)", async () => {
    const defs = await startAndCapture([{ id: 1, prompt: "do it" }]);
    assert.equal(defs[0].contract, undefined);
    assert.equal(defs[0].judge, undefined);
  });

  it("rejects an empty contract array", async () => {
    const server = mockServer();
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "bad-wf",
        graph: "1",
        tasks: [{ id: 1, prompt: "do it", contract: [] }],
        reply_to: "session:parent",
      },
      makeDeps(server),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /contract must be a non-empty array/);
  });

  it("rejects an invalid contract action", async () => {
    const server = mockServer();
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "bad-wf",
        graph: "1",
        tasks: [
          {
            id: 1,
            prompt: "do it",
            contract: [{ path: "a.ts", action: "move" as "create", summary: "s" }],
          },
        ],
        reply_to: "session:parent",
      },
      makeDeps(server),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /action must be create, update, or delete/);
  });

  it("rejects a contract entry with a blank summary", async () => {
    const server = mockServer();
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "bad-wf",
        graph: "1",
        tasks: [
          {
            id: 1,
            prompt: "do it",
            contract: [{ path: "a.ts", action: "create", summary: " " }],
          },
        ],
        reply_to: "session:parent",
      },
      makeDeps(server),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /summary must be a non-empty string/);
  });

  it("rejects a blank judge", async () => {
    const server = mockServer();
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "bad-wf",
        graph: "1",
        tasks: [{ id: 1, prompt: "do it", contract, judge: " " }],
        reply_to: "session:parent",
      },
      makeDeps(server),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /judge must be a non-empty string/);
  });
});

describe("orchestrator contract forwarding", () => {
  it("passes contract and judge through to the spawn adapter", async () => {
    const { Orchestrator } = await import("../src/orchestrator.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempDir = mkdtempSync(join(tmpdir(), "shoggoth-wf-contract-"));
    const spawnRequests: unknown[] = [];

    const spawner = {
      spawn: async (req: unknown) => {
        spawnRequests.push(req);
        return "session-key-1";
      },
      abortTask: () => {},
    };
    const poller = {
      poll: async () => ({ status: "running" as const }),
    };
    const notifier = {
      notify: async () => {},
    };

    const orchestrator = new Orchestrator({ spawner, poller, notifier });

    await orchestrator.start(
      [
        {
          id: 1,
          kind: "agent",
          prompt: "do the thing",
          failureBehavior: "continue",
          failureNotification: "silent",
          contract,
          judge: "typesafe-main/jev-latest",
        },
      ],
      "1",
      {
        stateDir: tempDir,
        currentDepth: 0,
        maxDepth: 3,
        replyTo: "session:parent",
        pollingIntervalMs: 60_000,
        runtimeLimitMs: 60_000,
      },
    );

    expect(spawnRequests).toHaveLength(1);
    const req = spawnRequests[0] as Record<string, unknown>;
    expect(req.contract).toEqual(contract);
    expect(req.judge).toBe("typesafe-main/jev-latest");
  });
});
