/**
 * Tests for deliverSubagentResult function in integration-ops.ts.
 * Tests delivery_mode handling: drop, inline (with/without active loop), queue.
 * Tests max-char truncation (default 8000).
 * Tests the Phase 2 structured-output OOB queue path (modelInvocationOverride).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  pushSteer,
  registerSteerChannel,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

// Mock ext.runSessionModelTurn
const mockRunSessionModelTurn = vi.fn().mockResolvedValue({});

describe("deliverSubagentResult", () => {
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

      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
    });
  });

  describe("delivery_mode='inline' with active loop", () => {
    it("should call pushSteer and NOT call runSessionModelTurn when active loop exists", async () => {
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

      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
      handle.unregister();
    });
  });

  describe("delivery_mode='inline' without active loop (fallback to queue)", () => {
    it("should call runSessionModelTurn when no active loop exists, with OOB structured override", async () => {
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
        modelInvocationOverride: {
          responseSchema: {
            schema: expect.objectContaining({
              type: "object",
              required: expect.arrayContaining(["to_operator", "to_sender"]),
            }),
          },
          structuredOutputMode: "best-effort",
        },
      });
    });
  });

  describe("delivery_mode='queue'", () => {
    it("should always call runSessionModelTurn regardless of active loop", async () => {
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

      expect(mockRunSessionModelTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userContent: expect.stringContaining("a".repeat(8000)),
        }),
      );
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

  describe("delivery reminders (Phase 2 structured output queue path)", () => {
    const baseReminder = "— Your reply text is delivered to the subagent, not to the operator.";

    it("inline+active-loop: appends base reminder, NOT the OOB guidance string", async () => {
      const handle = registerSteerChannel("parent-remind-steer");
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-remind-1",
        respondTo: "parent-remind-steer",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "inline",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      expect(mockRunSessionModelTurn).not.toHaveBeenCalled();
      const steers = drainSteers("parent-remind-steer");
      expect(steers).toHaveLength(1);
      const content = steers[0];
      expect(content).toContain("[Subagent completed]");
      expect(content).toContain(baseReminder);
      expect(content).not.toContain("out of band");
      expect(content).not.toContain("respond with structured output");
      handle.unregister();
    });

    it("async/queue: appends guidance string instead of old reminders", async () => {
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-remind-2",
        respondTo: "parent-remind-queue",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      expect(mockRunSessionModelTurn).toHaveBeenCalled();
      const arg = mockRunSessionModelTurn.mock.calls[0][0];
      const content: string = arg.userContent;
      expect(content).toContain("[Subagent completed]");
      // The structured output guidance replaces the old asyncOnlyReminder.
      expect(content).toContain("respond with structured output");
      expect(content).not.toContain("builtin-message action=post");
    });

    it("async/inline fallback: appends guidance string", async () => {
      mockRunSessionModelTurn.mockClear();
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-remind-3",
        respondTo: "parent-remind-fallback",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "inline",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      expect(mockRunSessionModelTurn).toHaveBeenCalled();
      const arg = mockRunSessionModelTurn.mock.calls[0][0];
      const content: string = arg.userContent;
      expect(content).toContain("[Subagent completed]");
      expect(content).toContain("respond with structured output");
      expect(content).not.toContain("builtin-message action=post");
    });

    it("reminders contain no platform-specific names", async () => {
      const { deliverSubagentResult } = await import("../../src/control/integration-ops");
      mockRunSessionModelTurn.mockClear();

      await deliverSubagentResult({ runSessionModelTurn: mockRunSessionModelTurn } as never, {
        childSessionId: "child-remind-4",
        respondTo: "parent-remind-platform",
        internalDelivery: true,
        mode: "one_shot",
        deliveryMode: "queue",
        assistantText: "test result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      });

      const content: string = mockRunSessionModelTurn.mock.calls[0][0].userContent;
      expect(content).not.toMatch(/discord|slack|telegram|teams/i);
    });
  });
});
