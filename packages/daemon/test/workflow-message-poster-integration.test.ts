import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDaemonMessagePoster } from "../src/workflow-adapters";
import type { Logger } from "../src/logging";

describe("workflow message poster integration", () => {
  let mockLogger: any;
  let mockMessageContext: any;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockMessageContext = {
      slice: {
        actions: ["post", "edit", "delete"],
      },
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  it("creates a message poster factory that uses lazy-loaded context", async () => {
    const contextRef = { current: undefined as any };

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-123");

    // Set context after factory creation (lazy loading)
    contextRef.current = mockMessageContext;

    await poster.post("channel-456", "Test message");

    expect(mockMessageContext.execute).toHaveBeenCalledWith(
      "channel-456",
      expect.objectContaining({
        action: "post",
        content: "Test message",
        target: "channel-456",
      })
    );
  });

  it("handles missing context gracefully", async () => {
    const contextRef = { current: undefined };

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-123");

    await poster.post("channel-456", "Test message");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "message task: no message context available",
      undefined
    );
  });

  it("logs message operations", async () => {
    const contextRef = { current: mockMessageContext };

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-123");

    await poster.post("channel-456", "Test message");

    expect(mockLogger.debug).toHaveBeenCalledWith(
      "message task posting",
      expect.objectContaining({
        target: "channel-456",
        messageLen: 12,
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "message task posted",
      expect.objectContaining({
        target: "channel-456",
      })
    );
  });

  it("handles execution errors", async () => {
    const contextRef = { current: mockMessageContext };
    mockMessageContext.execute.mockResolvedValue({ ok: false, error: "Permission denied" });

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-123");

    await poster.post("channel-456", "Test message");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "message task post failed",
      expect.objectContaining({
        target: "channel-456",
        error: "Permission denied",
      })
    );
  });

  it("handles execution exceptions", async () => {
    const contextRef = { current: mockMessageContext };
    mockMessageContext.execute.mockRejectedValue(new Error("Network error"));

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-123");

    await poster.post("channel-456", "Test message");

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "message task post threw",
      expect.objectContaining({
        target: "channel-456",
        err: "Error: Network error",
      })
    );
  });

  it("supports multiple concurrent posts", async () => {
    const contextRef = { current: mockMessageContext };

    const factory = (sessionId: string) =>
      createDaemonMessagePoster({
        getMessageContext: () => contextRef.current,
        logger: mockLogger,
      });

    const poster = factory("session-1");

    await Promise.all([
      poster.post("channel-1", "Message 1"),
      poster.post("channel-2", "Message 2"),
      poster.post("channel-3", "Message 3"),
    ]);

    expect(mockMessageContext.execute).toHaveBeenCalledTimes(3);
    expect(mockMessageContext.execute).toHaveBeenNthCalledWith(
      1,
      "channel-1",
      expect.any(Object)
    );
    expect(mockMessageContext.execute).toHaveBeenNthCalledWith(
      2,
      "channel-2",
      expect.any(Object)
    );
    expect(mockMessageContext.execute).toHaveBeenNthCalledWith(
      3,
      "channel-3",
      expect.any(Object)
    );
  });
});
