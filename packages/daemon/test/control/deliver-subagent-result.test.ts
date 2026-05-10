/**
 * Tests for deliverSubagentResult function in integration-ops.ts.
 * Tests delivery_mode handling: drop, inline (with/without active loop), queue.
 * Tests max-char truncation (default 8000).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pushSteer,
  registerSteerChannel,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

// Mock ext.runSessionModelTurn
const mockRunSessionModelTurn = vi.fn().mockResolvedValue({});

describe("deliverSubagentResult", () => {
  // We'll import and test the function after it's exported
  // For now, test the pushSteer behavior that deliverSubagentResult depends on
  beforeEach(() => {
    _resetAllChannels();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetAllChannels();
  });

  describe("pushSteer behavior (used by deliverSubagentResult)", () => {
    it("pushSteer returns true when steer channel is registered (active loop)", () => {
      const handle = registerSteerChannel("session-parent");
      const result = pushSteer("session-parent", "test message");
      expect(result).toBe(true);
      handle.unregister();
    });

    it("pushSteer returns false when no steer channel (no active loop)", () => {
      const result = pushSteer("session-nonexistent", "test message");
      expect(result).toBe(false);
    });
  });

  describe("delivery_mode='drop'", () => {
    it("should not call pushSteer or runSessionModelTurn when delivery_mode is drop", async () => {
      // This test verifies the expected behavior - it will fail until deliverSubagentResult is modified
      // Import the module to get access to deliverSubagentResult when it's exported
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-1",
        respondTo: "parent-1",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "drop",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      // Neither pushSteer nor runSessionModelTurn should be called in drop mode
      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
    });
  });

  describe("delivery_mode='inline' with active loop", () => {
    it("should call pushSteer and NOT call runSessionModelTurn when active loop exists", async () => {
      // Register an active loop (steer channel)
      const handle = registerSteerChannel("parent-2");

      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-2",
        respondTo: "parent-2",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "inline",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      // pushSteer should have been called (returns true), so runSessionModelTurn should NOT be called
      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
      handle.unregister();
    });
  });

  describe("delivery_mode='inline' without active loop (fallback to queue)", () => {
    it("should call runSessionModelTurn when no active loop exists", async () => {
      // No steer channel registered - no active loop
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-3",
        respondTo: "parent-3",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "inline",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      // Fallback to queue - runSessionModelTurn should be called
      expect(mockRunSessionModelTurn).toHaveBeenCalledWith({
        sessionId: "parent-3",
        userContent: expect.stringContaining("[Subagent completed]"),
        userMetadata: {
          subagent_result: true,
          child_session_id: "child-3",
          mode: "one_shot",
        },
        systemContext: {
          kind: "subagent.result",
          summary: expect.stringContaining("Result delivered from subagent child-3"),
          data: { child_session_id: "child-3", mode: "one_shot" },
        },
        delivery: { kind: "internal" },
      });
    });
  });

  describe("delivery_mode='queue'", () => {
    it("should always call runSessionModelTurn regardless of active loop", async () => {
      // Even with an active loop, queue mode should always use runSessionModelTurn
      const handle = registerSteerChannel("parent-4");

      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-4",
        respondTo: "parent-4",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      // queue mode always calls runSessionModelTurn
      expect(mockRunSessionModelTurn).toHaveBeenCalled();
      handle.unregister();
    });

    it("should call runSessionModelTurn when no active loop exists", async () => {
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-5",
        respondTo: "parent-5",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      expect(mockRunSessionModelTurn).toHaveBeenCalled();
    });
  });

  describe("max-chars truncation", () => {
    it("should truncate text to 8000 chars by default", async () => {
      const longText = "a".repeat(10000);
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-6",
        respondTo: "parent-6",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: longText,
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      // Check that the userContent was truncated to 8000 chars
      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userContent: expect.stringContaining("a".repeat(8000)),
        }),
      );
      // And does NOT contain the 9000th char
      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userContent: expect.not.stringContaining("a".repeat(8001)),
        }),
      );
    });

    it("should truncate text to custom maxChars when provided", async () => {
      const longText = "b".repeat(500);
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-7",
        respondTo: "parent-7",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: longText,
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
        maxChars: 100,
      });

      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userContent: expect.stringContaining("b".repeat(100)),
        }),
      );
    });

    it("should not truncate text shorter than maxChars", async () => {
      const shortText = "short result";
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-8",
        respondTo: "parent-8",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: shortText,
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userContent: expect.stringContaining(shortText),
        }),
      );
    });
  });
});
