import { describe, it } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  resolveUserPath,
  type BuiltinToolContext,
  type BuiltinToolHandler,
} from "../../src/sessions/builtin-tool-registry";

function stubCtx(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    sessionId: "sess-1",
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

describe("BuiltinToolRegistry", () => {
  it("returns false for unregistered tool names", () => {
    const reg = new BuiltinToolRegistry();
    assert.strictEqual(reg.has("nonexistent"), false);
  });

  it("returns true for registered tool names", () => {
    const reg = new BuiltinToolRegistry();
    reg.register("my.tool", async () => ({ resultJson: "{}" }));
    assert.strictEqual(reg.has("my.tool"), true);
  });

  it("executes the correct handler for a registered tool", async () => {
    const reg = new BuiltinToolRegistry();
    reg.register("echo", async (args) => ({
      resultJson: JSON.stringify({ echo: args.msg }),
    }));
    const result = await reg.execute("echo", { msg: "hi" }, stubCtx());
    assert.deepStrictEqual(JSON.parse(result.resultJson), { echo: "hi" });
  });

  it("throws for unregistered tool execution", async () => {
    const reg = new BuiltinToolRegistry();
    await assert.rejects(
      () => reg.execute("missing", {}, stubCtx()),
      (err: Error) => {
        assert.match(err.message, /No handler registered for builtin tool: missing/);
        return true;
      },
    );
  });

  it("handler receives the correct context and args", async () => {
    const reg = new BuiltinToolRegistry();
    let capturedArgs: Record<string, unknown> | undefined;
    let capturedCtx: BuiltinToolContext | undefined;

    const handler: BuiltinToolHandler = async (args, ctx) => {
      capturedArgs = args;
      capturedCtx = ctx;
      return { resultJson: "{}" };
    };
    reg.register("capture", handler);

    const ctx = stubCtx({ sessionId: "sess-capture" });
    await reg.execute("capture", { foo: "bar" }, ctx);

    assert.deepStrictEqual(capturedArgs, { foo: "bar" });
    assert.strictEqual(capturedCtx?.sessionId, "sess-capture");
  });

  it("multiple handlers can be registered without conflict", async () => {
    const reg = new BuiltinToolRegistry();
    reg.register("a", async () => ({ resultJson: '"a"' }));
    reg.register("b", async () => ({ resultJson: '"b"' }));

    const ra = await reg.execute("a", {}, stubCtx());
    const rb = await reg.execute("b", {}, stubCtx());
    assert.strictEqual(JSON.parse(ra.resultJson), "a");
    assert.strictEqual(JSON.parse(rb.resultJson), "b");
  });
});

describe("resolveUserPath", () => {
  it("returns absolute paths unchanged", () => {
    const ctx = stubCtx({ workspacePath: "/ws", workingDirectory: "/ws/sub" });
    assert.strictEqual(resolveUserPath(ctx, "/ws/other/file.txt"), "/ws/other/file.txt");
  });

  it("resolves relative paths against workingDirectory when set", () => {
    const ctx = stubCtx({ workspacePath: "/ws", workingDirectory: "/ws/sub" });
    assert.strictEqual(resolveUserPath(ctx, "file.txt"), "/ws/sub/file.txt");
  });

  it("resolves relative paths against workspacePath when workingDirectory is undefined", () => {
    const ctx = stubCtx({ workspacePath: "/ws", workingDirectory: undefined });
    assert.strictEqual(resolveUserPath(ctx, "file.txt"), "/ws/file.txt");
  });

  it("resolves .. relative to workingDirectory", () => {
    const ctx = stubCtx({ workspacePath: "/ws", workingDirectory: "/ws/a/b" });
    assert.strictEqual(resolveUserPath(ctx, "../c.txt"), "/ws/a/c.txt");
  });
});