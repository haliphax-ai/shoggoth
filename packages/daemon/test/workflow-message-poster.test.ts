import { describe, it, expect, vi } from "vitest";
import { createDaemonMessagePoster } from "../src/workflow-adapters";

describe("createDaemonMessagePoster", () => {
  it("should post a message through the message context", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ ok: true, message_id: "msg-123" });
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const poster = createDaemonMessagePoster({
      getMessageContext: () => ({ execute: mockExecute }),
      logger: mockLogger,
    });

    await poster.post("channel-456", "Hello from workflow");

    expect(mockExecute).toHaveBeenCalledWith("channel-456", {
      action: "post",
      content: "Hello from workflow",
      target: "channel-456",
    });
    expect(mockLogger.debug).toHaveBeenCalledWith("message task posted", { target: "channel-456" });
  });

  it("should handle missing message context gracefully", async () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const poster = createDaemonMessagePoster({
      getMessageContext: () => undefined,
      logger: mockLogger,
    });

    await poster.post("channel-456", "Hello from workflow");

    expect(mockLogger.warn).toHaveBeenCalledWith("message task: no message context available", undefined);
  });

  it("should handle post failures", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ ok: false, error: "Permission denied" });
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const poster = createDaemonMessagePoster({
      getMessageContext: () => ({ execute: mockExecute }),
      logger: mockLogger,
    });

    await poster.post("channel-456", "Hello from workflow");

    expect(mockLogger.warn).toHaveBeenCalledWith("message task post failed", {
      target: "channel-456",
      error: "Permission denied",
    });
  });
});
