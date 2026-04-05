import { describe, it, expect, vi } from "vitest";
import { createDaemonToolExecutor } from "../src/workflow-adapters.js";
import type { ToolExecutor } from "@shoggoth/workflow";

describe("createDaemonToolExecutor", () => {
  it("should execute a tool with lazy-loaded context", async () => {
    const mockContext = {
      execute: vi.fn().mockResolvedValue({
        resultJson: JSON.stringify({ success: true, data: "result" }),
      }),
    };

    const getToolContext = vi.fn().mockResolvedValue(mockContext);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

    const result = await executor.execute({
      name: "test-tool",
      argsJson: JSON.stringify({ arg1: "value1" }),
      toolCallId: "call-123",
    });

    expect(getToolContext).toHaveBeenCalled();
    expect(mockContext.execute).toHaveBeenCalledWith({
      name: "test-tool",
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

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

    const result = await executor.execute({
      name: "test-tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-456",
    });

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.error).toBe("no_context");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no context available"),
      expect.any(Object)
    );
  });

  it("should log execution errors", async () => {
    const mockContext = {
      execute: vi.fn().mockRejectedValue(new Error("Tool execution failed")),
    };

    const getToolContext = vi.fn().mockResolvedValue(mockContext);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

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
      expect.any(Object)
    );
  });

  it("should log debug messages during execution", async () => {
    const mockContext = {
      execute: vi.fn().mockResolvedValue({
        resultJson: JSON.stringify({ ok: true }),
      }),
    };

    const getToolContext = vi.fn().mockResolvedValue(mockContext);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

    await executor.execute({
      name: "logged-tool",
      argsJson: JSON.stringify({}),
      toolCallId: "call-debug",
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("executing"),
      expect.any(Object)
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("context resolved"),
      expect.any(Object)
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("execution completed"),
      expect.any(Object)
    );
  });

  it("should handle concurrent tool executions", async () => {
    const mockContext = {
      execute: vi.fn().mockImplementation(async ({ toolCallId }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          resultJson: JSON.stringify({ toolCallId, result: "done" }),
        };
      }),
    };

    const getToolContext = vi.fn().mockResolvedValue(mockContext);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

    const results = await Promise.all([
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

    expect(results).toHaveLength(3);
    expect(mockContext.execute).toHaveBeenCalledTimes(3);
  });

  it("should return ToolExecutor interface", () => {
    const getToolContext = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

    expect(executor).toHaveProperty("execute");
    expect(typeof executor.execute).toBe("function");
  });

  it("should handle non-Error exceptions", async () => {
    const mockContext = {
      execute: vi.fn().mockRejectedValue("string error"),
    };

    const getToolContext = vi.fn().mockResolvedValue(mockContext);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const executor = createDaemonToolExecutor({
      getToolContext,
      logger,
    });

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
