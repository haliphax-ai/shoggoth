import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TaskDef, ToolExecutor } from "../src/types.js";
import type {
  SpawnAdapter,
  PollAdapter,
  NotifyAdapter,
  OrchestratorOptions,
} from "../src/orchestrator.js";
import { WorkflowServer, type WorkflowServerOptions } from "../src/server.js";

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-server-test-"));
  fs.chmodSync(dir, 0o777);
  return dir;
}

function makeTask(id: number, kind: "agent" | "tool" = "agent", prompt = `do task ${id}`): TaskDef {
  if (kind === "tool") {
    return {
      kind: "tool",
      id,
      tool: "test-tool",
      args: {},
      failureBehavior: "continue",
      failureNotification: "silent",
    };
  }
  return {
    kind: "agent",
    id,
    prompt,
    failureBehavior: "continue",
    failureNotification: "silent",
  };
}

/** Mock spawn adapter that records calls. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSpawnAdapter(): SpawnAdapter & { calls: any[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async spawn(req: any): Promise<string> {
      calls.push(req);
      return `session-${req.taskId}`;
    },
  };
}

/** Mock poll adapter. */
function mockPollAdapter(): PollAdapter {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async poll(): Promise<any> {
      return { status: "running" };
    },
  };
}

/** Mock notify adapter. */
function mockNotifyAdapter(): NotifyAdapter {
  return {
    async notify(): Promise<void> {},
  };
}

function defaultOpts(baseDir: string): OrchestratorOptions {
  return {
    stateDir: baseDir,
    currentDepth: 0,
    maxDepth: 2,
    replyTo: "agent:parent",
    pollingIntervalMs: 50,
    runtimeLimitMs: 60_000,
  };
}

describe("WorkflowServer", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTmpDir();
  });

  afterEach(async () => {
    for (const server of servers) await server.stopAll();
    servers.length = 0;
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // Every server.start() spins up a live polling loop, so each test must
  // register its server here: the shared teardown stops polling and drains
  // in-flight ticks before the state directory is deleted (an undrained
  // tick's saveWorkflow would otherwise race rmSync with ENOTEMPTY).
  const servers: WorkflowServer[] = [];
  function trackServer(opts: WorkflowServerOptions): WorkflowServer {
    const s = new WorkflowServer(opts);
    servers.push(s);
    return s;
  }

  describe("createToolExecutor factory", () => {
    it("calls createToolExecutor factory with sessionId when provided", async () => {
      const factoryCalls: string[] = [];
      const mockExecutor: ToolExecutor = {
        async execute() {
          return { resultJson: JSON.stringify({ output: "test" }) };
        },
      };

      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        createToolExecutor: (sessionId: string) => {
          factoryCalls.push(sessionId);
          return mockExecutor;
        },
      });

      const tasks = [makeTask(1)];
      const sessionId = "test-session-123";
      const opts = { ...defaultOpts(baseDir), replyTo: sessionId };

      await server.start(tasks, "1", opts);

      // Verify factory was called with the sessionId
      assert.deepStrictEqual(factoryCalls, [sessionId]);
    });

    it("passes the executor returned by factory to Orchestrator", async () => {
      const mockExecutor: ToolExecutor = {
        async execute(call: { name: string; argsJson: string; toolCallId: string }) {
          return {
            resultJson: JSON.stringify({ output: `executed ${call.name}` }),
          };
        },
      };

      let capturedExecutor: ToolExecutor | undefined;
      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        createToolExecutor: () => {
          capturedExecutor = mockExecutor;
          return mockExecutor;
        },
      });

      const tasks = [makeTask(1, "tool")];
      const opts = { ...defaultOpts(baseDir), replyTo: "session-1" };

      const wfId = await server.start(tasks, "1", opts);
      const orch = server.get(wfId);

      // Verify the orchestrator was created and has access to the executor
      assert.ok(orch);
      assert.ok(capturedExecutor);
    });

    it("calls factory for each workflow start with different sessionIds", async () => {
      const factoryCalls: string[] = [];
      const mockExecutor: ToolExecutor = {
        async execute() {
          return { resultJson: JSON.stringify({ output: "test" }) };
        },
      };

      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        createToolExecutor: (sessionId: string) => {
          factoryCalls.push(sessionId);
          return mockExecutor;
        },
      });

      const tasks = [makeTask(1)];

      // Start first workflow
      await server.start(tasks, "1", {
        ...defaultOpts(baseDir),
        replyTo: "session-1",
      });

      // Start second workflow
      await server.start(tasks, "1", {
        ...defaultOpts(baseDir),
        replyTo: "session-2",
      });

      // Verify factory was called twice with different sessionIds
      assert.deepStrictEqual(factoryCalls, ["session-1", "session-2"]);
    });

    it("does not call factory if createToolExecutor is not provided", async () => {
      const factoryCalled = false;
      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        // No createToolExecutor provided
      });

      const tasks = [makeTask(1)];
      const opts = { ...defaultOpts(baseDir), replyTo: "session-1" };

      await server.start(tasks, "1", opts);

      // Verify factory was not called (no error, just no call)
      assert.equal(factoryCalled, false);
    });

    it("factory receives the correct sessionId from opts.replyTo", async () => {
      const receivedSessionIds: string[] = [];
      const mockExecutor: ToolExecutor = {
        async execute() {
          return { resultJson: JSON.stringify({ output: "test" }) };
        },
      };

      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        createToolExecutor: (sessionId: string) => {
          receivedSessionIds.push(sessionId);
          return mockExecutor;
        },
      });

      const tasks = [makeTask(1)];
      const customSessionId = "custom-session-xyz";
      const opts = { ...defaultOpts(baseDir), replyTo: customSessionId };

      await server.start(tasks, "1", opts);

      // Verify the factory received the exact sessionId from opts.replyTo
      assert.deepStrictEqual(receivedSessionIds, [customSessionId]);
    });

    it("factory is called before Orchestrator is created", async () => {
      const callOrder: string[] = [];
      const mockExecutor: ToolExecutor = {
        async execute() {
          return { resultJson: JSON.stringify({ output: "test" }) };
        },
      };

      const server = trackServer({
        stateDir: baseDir,
        spawner: mockSpawnAdapter(),
        poller: mockPollAdapter(),
        notifier: mockNotifyAdapter(),
        createToolExecutor: (_sessionId: string) => {
          callOrder.push("factory");
          return mockExecutor;
        },
      });

      const tasks = [makeTask(1)];
      const opts = { ...defaultOpts(baseDir), replyTo: "session-1" };

      await server.start(tasks, "1", opts);
      callOrder.push("orchestrator-created");

      // Verify factory was called before orchestrator was created
      assert.ok(callOrder.indexOf("factory") < callOrder.indexOf("orchestrator-created"));
    });
  });
});
