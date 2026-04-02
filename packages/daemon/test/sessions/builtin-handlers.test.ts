import { describe, it } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerConfig } from "../../src/sessions/builtin-handlers/config-handlers";
import { register as registerProcman } from "../../src/sessions/builtin-handlers/procman-handlers";
import { register as registerMessage } from "../../src/sessions/builtin-handlers/message-handler";

function stubCtx(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    db: {} as any,
    config: {} as any,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// config.show
// ---------------------------------------------------------------------------

describe("config.show handler", () => {
  it("returns error when integration invoker is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const result = await reg.execute("config-show", {}, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "config_show_unavailable",
    });
  });

  it("returns result from integration invoker", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async (_sid: string, _op: string, _payload: unknown) => ({ some: "config" }),
    });
    const result = await reg.execute("config-show", {}, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), { some: "config" });
  });

  it("catches IntegrationOpError and returns structured error", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    // Dynamically import IntegrationOpError to construct a real instance
    const { IntegrationOpError } = await import("../../src/control/integration-ops");
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async () => { throw new IntegrationOpError("FORBIDDEN", "not allowed"); },
    });
    const result = await reg.execute("config-show", {}, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, "FORBIDDEN");
    assert.strictEqual(parsed.message, "not allowed");
  });
});

// ---------------------------------------------------------------------------
// config.request
// ---------------------------------------------------------------------------

describe("config.request handler", () => {
  it("returns error when integration invoker is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    const result = await reg.execute("config-request", { fragment: "agents" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "config_request_unavailable",
    });
  });

  it("passes fragment to integration invoker", async () => {
    const reg = new BuiltinToolRegistry();
    registerConfig(reg);
    let capturedPayload: unknown;
    const ctx = stubCtx({
      getAgentIntegrationInvoker: () =>
        async (_sid: string, _op: string, payload: unknown) => {
          capturedPayload = payload;
          return { ok: true };
        },
    });
    const result = await reg.execute("config-request", { fragment: "agents" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), { ok: true });
    assert.deepStrictEqual(capturedPayload, { fragment: "agents" });
  });
});

// ---------------------------------------------------------------------------
// procman
// ---------------------------------------------------------------------------

describe("procman handler", () => {
  it("returns error when process manager is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const result = await reg.execute("procman", { action: "list" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "process manager not available",
    });
  });

  it("lists processes", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = {
      list: () => [
        {
          spec: { id: "proc-1", label: "test", owner: "agent:test" },
          state: "running",
          pid: 1234,
          uptimeMs: 5000,
          restartCount: 0,
        },
      ],
    };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "list" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.processes.length, 1);
    assert.strictEqual(parsed.processes[0].id, "proc-1");
    assert.strictEqual(parsed.processes[0].state, "running");
    assert.strictEqual(parsed.processes[0].pid, 1234);
  });

  it("inspects a process by id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = {
      get: (id: string) =>
        id === "proc-1"
          ? {
              spec: { id: "proc-1", label: "test", owner: "agent:test" },
              state: "running",
              pid: 1234,
              uptimeMs: 5000,
              restartCount: 0,
              lastExitCode: null,
              lastSignal: null,
              readOutput: (stream: string) => stream === "stdout" ? "hello" : "",
            }
          : undefined,
    };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect", id: "proc-1" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.id, "proc-1");
    assert.strictEqual(parsed.recentStdout, "hello");
    assert.strictEqual(parsed.recentStderr, "");
  });

  it("returns error for inspect without id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { get: () => undefined };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "id required for inspect",
    });
  });

  it("returns error for unknown process id", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { get: () => undefined };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "inspect", id: "nope" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: 'no process with id "nope"',
    });
  });

  it("returns error for unknown action", async () => {
    const reg = new BuiltinToolRegistry();
    registerProcman(reg);
    const mockPm = { list: () => [] };
    const ctx = stubCtx({
      getProcessManager: () => mockPm as any,
    });
    const result = await reg.execute("procman", { action: "restart" }, ctx);
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "unknown procman action: restart",
    });
  });
});

// ---------------------------------------------------------------------------
// message handler
// ---------------------------------------------------------------------------

describe("message handler", () => {
  it("returns error when message tool context is unavailable", async () => {
    const reg = new BuiltinToolRegistry();
    registerMessage(reg);
    const result = await reg.execute("message", { action: "send" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), {
      error: "message_tool_unavailable",
    });
  });

  it("delegates to message tool context execute", async () => {
    const reg = new BuiltinToolRegistry();
    registerMessage(reg);
    let capturedArgs: Record<string, unknown> | undefined;
    const ctx = stubCtx({
      messageToolCtx: {
        execute: async (_sid: string, args: Record<string, unknown>) => {
          capturedArgs = args;
          return { ok: true, messageId: "msg-1" };
        },
      },
    });
    const result = await reg.execute("message", { action: "send", target: "#general" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.messageId, "msg-1");
    assert.deepStrictEqual(capturedArgs, { action: "send", target: "#general" });
  });
});
