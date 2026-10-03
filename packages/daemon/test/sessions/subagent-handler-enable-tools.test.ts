import { describe, it } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSubagent } from "../../src/sessions/builtin-handlers/session-handlers";

function stubCtx(invoker: (op: string, payload: unknown) => Promise<unknown>): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => async (_sid, op, payload) => invoker(op, payload),
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("builtin-subagent enable_tools passthrough", () => {
  it("forwards enable_tools on spawn_one_shot", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    let captured: { op: string; payload: Record<string, unknown> } | undefined;
    const result = await reg.execute(
      "subagent",
      {
        action: "spawn_one_shot",
        prompt: "do it",
        enable_tools: ["kanban-*", "builtin-exec"],
      },
      stubCtx(async (op, payload) => {
        captured = { op, payload: payload as Record<string, unknown> };
        return { session_id: "agent:test:discord:channel:123:child", reply: "ok" };
      }),
    );
    JSON.parse(result.resultJson); // must not throw
    assert.ok(captured);
    assert.equal(captured!.op, "subagent_spawn");
    assert.deepStrictEqual(captured!.payload.enable_tools, ["kanban-*", "builtin-exec"]);
  });

  it("forwards enable_tools on spawn_persistent", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    let captured: { op: string; payload: Record<string, unknown> } | undefined;
    await reg.execute(
      "subagent",
      {
        action: "spawn_persistent",
        prompt: "do it",
        thread_id: "555",
        enable_tools: ["lsp-*"],
      },
      stubCtx(async (op, payload) => {
        captured = { op, payload: payload as Record<string, unknown> };
        return { session_id: "child-2", mode: "persistent" };
      }),
    );
    assert.ok(captured);
    assert.deepStrictEqual(captured!.payload.enable_tools, ["lsp-*"]);
  });

  it("drops malformed enable_tools instead of forwarding them", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    let captured: { payload: Record<string, unknown> } | undefined;
    await reg.execute(
      "subagent",
      {
        action: "spawn_one_shot",
        prompt: "do it",
        enable_tools: ["ok", 42],
      },
      stubCtx(async (_op, payload) => {
        captured = { payload: payload as Record<string, unknown> };
        return { session_id: "child-3", reply: "ok" };
      }),
    );
    assert.ok(captured);
    assert.equal(captured!.payload.enable_tools, undefined);
  });
});
