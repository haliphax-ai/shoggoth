import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDaemonToolExecutor } from "../src/workflow-adapters.js";

/** Build an aggregated entry so routeMcpToolInvocation can find it by namespacedName. */
function aggTool(namespacedName: string, sourceId = "external") {
  return {
    name: namespacedName,
    namespacedName,
    sourceId,
    originalName: namespacedName,
    inputSchema: { type: "object" as const },
  };
}

function mockContext(
  toolNames: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  externalFn?: (...args: any[]) => Promise<{ resultJson: string }>,
) {
  return {
    aggregated: { tools: toolNames.map((n) => aggTool(n)) },
    toolsOpenAi: [],
    toolsLoop: { tools: [], nameMap: new Map() },
    external: externalFn ?? vi.fn().mockResolvedValue({ resultJson: "{}" }),
  };
}

describe("createDaemonToolExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should execute a tool with lazy-loaded context", async () => {
    const externalFn = vi.fn().mockResolvedValue({
      resultJson: JSON.stringify({ success: true, data: "result" }),
    });
    const ctx = mockContext(["test-tool"], externalFn);
    const getToolContext = vi.fn().mockResolvedValue(ctx);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    const result = await executor.execute({
      name: "test-tool",
      argsJson: JSON.stringify({ arg1: "value1" }),
      toolCallId: "call-123",
    });

    expect(getToolContext).toHaveBeenCalled();
    expect(externalFn).toHaveBeenCalledWith({
      sourceId: "external",
      originalName: "test-tool",
      argsJson: JSON.stringify({ arg1: "value1" }),
      toolCallId: "call-123",
    });
    expect(result.resultJson).toContain("success");
  });

  it("should handle missing context gracefully", async () => {
    const getToolContext = vi.fn().mockResolvedValue(undefined);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    const result = await executor.execute({
      name: "test-tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-456",
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.error).toBe("no_context");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no context available"),
      expect.any(Object),
    );
  });

  it("should log execution errors", async () => {
    const externalFn = vi.fn().mockRejectedValue(new Error("Tool execution failed"));
    const ctx = mockContext(["failing-tool"], externalFn);
    const getToolContext = vi.fn().mockResolvedValue(ctx);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    const result = await executor.execute({
      name: "failing-tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-789",
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.error).toBe("execution_failed");
    expect(parsed.message).toContain("Tool execution failed");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("execution failed"),
      expect.any(Object),
    );
  });

  it("should log debug messages during execution", async () => {
    const externalFn = vi.fn().mockResolvedValue({
      resultJson: JSON.stringify({ ok: true }),
    });
    const ctx = mockContext(["logged-tool"], externalFn);
    const getToolContext = vi.fn().mockResolvedValue(ctx);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    await executor.execute({
      name: "logged-tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-debug",
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("executing"),
      expect.any(Object),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("context resolved"),
      expect.any(Object),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("execution completed"),
      expect.any(Object),
    );
  });

  it("should handle concurrent tool executions", async () => {
    const externalFn = vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async ({ toolCallId }: any) => {
        await vi.advanceTimersByTimeAsync(10);
        return { resultJson: JSON.stringify({ toolCallId, result: "done" }) };
      });
    const ctx = mockContext(["tool-1", "tool-2", "tool-3"], externalFn);
    const getToolContext = vi.fn().mockResolvedValue(ctx);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    // Start all executions without awaiting — timers fire via advanceTimersByTimeAsync
    const resultsPromise = Promise.all([
      executor.execute({
        name: "tool-1",
        argsJson: JSON.stringify({}),
        toolCallId: "concurrent-1",
      }),
      executor.execute({
        name: "tool-2",
        argsJson: JSON.stringify({}),
        toolCallId: "concurrent-2",
      }),
      executor.execute({
        name: "tool-3",
        argsJson: JSON.stringify({}),
        toolCallId: "concurrent-3",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    const results = await resultsPromise;

    expect(results).toHaveLength(3);
    expect(externalFn).toHaveBeenCalledTimes(3);
  });

  it("should return ToolExecutor interface", () => {
    const getToolContext = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    expect(executor).toHaveProperty("execute");
    expect(typeof executor.execute).toBe("function");
  });

  it("should handle non-Error exceptions", async () => {
    const externalFn = vi.fn().mockRejectedValue("string error");
    const ctx = mockContext(["tool"], externalFn);
    const getToolContext = vi.fn().mockResolvedValue(ctx);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({ getToolContext, logger });

    const result = await executor.execute({
      name: "tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-string-error",
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.error).toBe("execution_failed");
    expect(parsed.message).toBe("string error");
  });
});
