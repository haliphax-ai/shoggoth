import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BuiltinToolContext } from "../../src/sessions/builtin-tool-registry";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register } from "../../src/sessions/builtin-handlers/exec-handler";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";

// Mock the os-exec module
vi.mock("@shoggoth/os-exec", () => ({
  toolExec: vi.fn(),
  toolExecExtended: vi.fn(),
  toolPoll: vi.fn(),
}));

import { toolExecExtended, toolExec } from "@shoggoth/os-exec";

function makeConfig(): ShoggothConfig {
  return { ...defaultConfig("/tmp/cfg") } as ShoggothConfig;
}

function makeCtx(config: ShoggothConfig): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    config,
    env: process.env,
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: config.memory,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("exec-handler", () => {
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handler integration contract", () => {
    it("detects file output params as extended usage (passes them to toolExecExtended)", async () => {
      const ctx = makeCtx(makeConfig());

      // Mock toolExecExtended to return a result with file output
      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        outputFile: "output.txt",
      } as any);

      await registry.execute("exec", { argv: ["echo", "hello"], outputFile: "output.txt" }, ctx);

      // Should have called toolExecExtended (not toolExec)
      expect(toolExecExtended).toHaveBeenCalledOnce();
      expect(toolExec).not.toHaveBeenCalled();

      // Should have passed the outputFile parameter
      const callArgs = vi.mocked(toolExecExtended).mock.calls[0];
      expect(callArgs[1]).toHaveProperty("outputFile", "output.txt");
    });

    it("detects stdoutFile as extended usage", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        stdoutFile: "stdout.txt",
        stderr: "error message",
      } as any);

      await registry.execute("exec", { argv: ["echo", "hello"], stdoutFile: "stdout.txt" }, ctx);

      expect(toolExecExtended).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(toolExecExtended).mock.calls[0];
      expect(callArgs[1]).toHaveProperty("stdoutFile", "stdout.txt");
    });

    it("detects stderrFile as extended usage", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        stderrFile: "stderr.txt",
        stdout: "output message",
      } as any);

      await registry.execute("exec", { argv: ["echo", "hello"], stderrFile: "stderr.txt" }, ctx);

      expect(toolExecExtended).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(toolExecExtended).mock.calls[0];
      expect(callArgs[1]).toHaveProperty("stderrFile", "stderr.txt");
    });

    it("returns outputFile in resultJson when present in tool result", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        outputFile: "output.txt",
      } as any);

      const result = await registry.execute(
        "exec",
        { argv: ["echo", "hello"], outputFile: "output.txt" },
        ctx,
      );

      const parsed = JSON.parse(result.resultJson);
      expect(parsed).toHaveProperty("outputFile", "output.txt");
      expect(parsed).not.toHaveProperty("output");
      expect(parsed).not.toHaveProperty("stdout");
      expect(parsed).not.toHaveProperty("stderr");
    });

    it("returns stdoutFile in resultJson when present in tool result", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        stdoutFile: "stdout.txt",
        stderr: "error content",
      } as any);

      const result = await registry.execute(
        "exec",
        { argv: ["echo", "hello"], stdoutFile: "stdout.txt" },
        ctx,
      );

      const parsed = JSON.parse(result.resultJson);
      expect(parsed).toHaveProperty("stdoutFile", "stdout.txt");
      expect(parsed).toHaveProperty("stderr", "error content");
      expect(parsed).not.toHaveProperty("stdout");
      expect(parsed).not.toHaveProperty("output");
    });

    it("returns stderrFile in resultJson when present in tool result", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        stderrFile: "stderr.txt",
        stdout: "output content",
      } as any);

      const result = await registry.execute(
        "exec",
        { argv: ["echo", "hello"], stderrFile: "stderr.txt" },
        ctx,
      );

      const parsed = JSON.parse(result.resultJson);
      expect(parsed).toHaveProperty("stderrFile", "stderr.txt");
      expect(parsed).toHaveProperty("stdout", "output content");
      expect(parsed).not.toHaveProperty("stderr");
      expect(parsed).not.toHaveProperty("output");
    });

    it("returns both stdoutFile and stderrFile in resultJson when both are present", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        stdoutFile: "stdout.txt",
        stderrFile: "stderr.txt",
      } as any);

      const result = await registry.execute(
        "exec",
        { argv: ["echo", "hello"], stdoutFile: "stdout.txt", stderrFile: "stderr.txt" },
        ctx,
      );

      const parsed = JSON.parse(result.resultJson);
      expect(parsed).toHaveProperty("stdoutFile", "stdout.txt");
      expect(parsed).toHaveProperty("stderrFile", "stderr.txt");
      expect(parsed).not.toHaveProperty("stdout");
      expect(parsed).not.toHaveProperty("stderr");
      expect(parsed).not.toHaveProperty("output");
    });

    it("does NOT wrap file paths in truncateToolOutput()", async () => {
      const ctx = makeCtx(makeConfig());

      // Note: truncateToolOutput should not be called for file paths

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        outputFile: "output.txt",
      } as any);

      await registry.execute("exec", { argv: ["echo", "hello"], outputFile: "output.txt" }, ctx);

      // The handler should not call truncateToolOutput on file paths
      // (This test documents the expected behavior - file paths should be returned as-is)
      // Note: We can't easily verify this without more complex mocking
    });

    it("includes exitCode in resultJson regardless of file output mode", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 42,
        signal: null,
        outputFile: "output.txt",
      } as any);

      const result = await registry.execute(
        "exec",
        { argv: ["echo", "hello"], outputFile: "output.txt" },
        ctx,
      );

      const parsed = JSON.parse(result.resultJson);
      expect(parsed).toHaveProperty("exitCode", 42);
      expect(parsed).toHaveProperty("outputFile", "output.txt");
    });

    it("still calls toolExec when no file output params are present", async () => {
      const ctx = makeCtx(makeConfig());

      vi.mocked(toolExec).mockResolvedValueOnce({
        exitCode: 0,
        stdout: "hello",
        stderr: "",
      });

      await registry.execute("exec", { argv: ["echo", "hello"] }, ctx);

      expect(toolExec).toHaveBeenCalledOnce();
      expect(toolExecExtended).not.toHaveBeenCalled();

      // Note: The handler currently doesn't format the result from toolExec,
      // so we can't easily verify the resultJson content
    });
  });

  describe("$vault: env resolution", () => {
    it("resolves $vault: references in env vars before passing to toolExecExtended", async () => {
      const config = makeConfig();
      const ctx = makeCtx(config);

      // Add a mock vault service to the context
      const mockVault = {
        get: vi.fn().mockImplementation((scope: string, name: string) => {
          if (scope === "agent:test" && name === "MY_SECRET") return "resolved-secret";
          if (scope === "global" && name === "GLOBAL_KEY") return "global-value";
          return null;
        }),
        resolve: vi.fn().mockImplementation((_agentId: string, name: string) => {
          if (name === "MY_SECRET") return "resolved-secret";
          return null;
        }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        listScopes: vi.fn(),
        rotateKey: vi.fn(),
        publicKey: "age1test",
      };
      (ctx as any).vault = mockVault;

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        output: "done",
      } as any);

      await registry.execute(
        "exec",
        {
          argv: ["my-cmd"],
          env: { SECRET: "$vault:MY_SECRET", PLAIN: "hello" },
        },
        ctx,
      );

      expect(toolExecExtended).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(toolExecExtended).mock.calls[0];
      // The env should have the vault reference resolved
      expect(callArgs[1].env).toEqual({ SECRET: "resolved-secret", PLAIN: "hello" });
    });

    it("passes env through unchanged when vault is not available", async () => {
      const config = makeConfig();
      const ctx = makeCtx(config);
      // No vault on ctx

      vi.mocked(toolExecExtended).mockResolvedValueOnce({
        kind: "foreground",
        exitCode: 0,
        signal: null,
        output: "done",
      } as any);

      await registry.execute(
        "exec",
        {
          argv: ["my-cmd"],
          env: { SECRET: "$vault:MY_SECRET", PLAIN: "hello" },
        },
        ctx,
      );

      expect(toolExecExtended).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(toolExecExtended).mock.calls[0];
      // Without vault, env passes through as-is
      expect(callArgs[1].env).toEqual({ SECRET: "$vault:MY_SECRET", PLAIN: "hello" });
    });
  });
});
