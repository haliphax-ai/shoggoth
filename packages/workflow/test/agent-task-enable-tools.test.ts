import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  SpawnRequest,
  SpawnAdapter,
  PollAdapter,
  NotifyAdapter,
} from "../src/orchestrator.js";
import { handleWorkflowToolCall } from "../src/tool-handler.js";
import type { AgentTaskDef } from "../src/types.js";
import type { WorkflowServer } from "../src/server.js";

function makeSpawner(captured: SpawnRequest[]): SpawnAdapter {
  let counter = 0;
  return {
    async spawn(req) {
      captured.push(req);
      return `session-${++counter}`;
    },
  };
}

const noopPoller: PollAdapter = { poll: async () => ({ status: "running" }) };
const noopNotifier: NotifyAdapter = { notify: async () => {} };

function agentTask(enableTools?: string[]): AgentTaskDef {
  return {
    kind: "agent",
    id: 1,
    prompt: "analyze",
    failureBehavior: "continue",
    failureNotification: "silent",
    ...(enableTools ? { enableTools } : {}),
  };
}

describe("workflow agent task enableTools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoggoth-et-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes enableTools through SpawnRequest", async () => {
    const captured: SpawnRequest[] = [];
    const orchestrator = new Orchestrator({
      spawner: makeSpawner(captured),
      poller: noopPoller,
      notifier: noopNotifier,
    });

    await orchestrator.start([agentTask(["kanban-*", "builtin-exec"])], "1", {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 2,
      replyTo: "agent:test:discord:channel:1",
      pollingIntervalMs: 10_000,
      runtimeLimitMs: 60_000,
    });

    assert.equal(captured.length, 1);
    assert.deepStrictEqual(captured[0].enableTools, ["kanban-*", "builtin-exec"]);
  });

  it("omits enableTools from SpawnRequest when the task has none", async () => {
    const captured: SpawnRequest[] = [];
    const orchestrator = new Orchestrator({
      spawner: makeSpawner(captured),
      poller: noopPoller,
      notifier: noopNotifier,
    });

    await orchestrator.start([agentTask()], "1", {
      stateDir: tempDir,
      currentDepth: 0,
      maxDepth: 2,
      replyTo: "agent:test:discord:channel:1",
      pollingIntervalMs: 10_000,
      runtimeLimitMs: 60_000,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].enableTools, undefined);
  });

  it("toTaskDefs maps enable_tools to enableTools on the AgentTaskDef", async () => {
    const capturedTasks: AgentTaskDef[] = [];
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "et-wf",
        reply_to: "agent:test",
        graph: "1",
        tasks: [
          {
            id: 1,
            kind: "agent",
            prompt: "Analyze",
            enable_tools: ["kanban-*"],
          },
        ],
      },
      {
        server: {
          start: async (tasks: AgentTaskDef[]) => {
            capturedTasks.push(...tasks);
            return "wf-et";
          },
        } as unknown as WorkflowServer,
        controlPlane: {} as never,
        stateDir: tempDir,
        currentDepth: 0,
        maxDepth: 3,
      },
    );

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(capturedTasks.length, 1);
    assert.deepStrictEqual(capturedTasks[0].enableTools, ["kanban-*"]);
  });

  it("rejects a malformed enable_tools list", async () => {
    const result = await handleWorkflowToolCall(
      {
        action: "start",
        name: "et-bad",
        reply_to: "agent:test",
        graph: "1",
        tasks: [
          {
            id: 1,
            kind: "agent",
            prompt: "Analyze",
            enable_tools: [""],
          } as never,
        ],
      },
      {
        server: { start: async () => "wf-bad" } as unknown as WorkflowServer,
        controlPlane: {} as never,
        stateDir: tempDir,
        currentDepth: 0,
        maxDepth: 3,
      },
    );

    assert.equal(result.ok, false);
    assert.match(String(result.error), /enable_tools/);
  });
});
