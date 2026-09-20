/**
 * RED tests for deliverOobStructuredResponse in integration-ops.ts (Phase 2).
 *
 * After the parent's queue-path model turn completes with a structured OOB
 * response, the response JSON is parsed and routed:
 * - `to_operator` → posted to the platform's operator surface (via ext.postToOperator)
 * - `to_sender`   → delivered to the originating subagent/sender session
 *                   (via pushSteer when an active steer channel exists, else runSessionModelTurn)
 *
 * The function does not exist yet — importing it fails (module not found).
 * That is the intended RED state for Phase 2.
 *
 * Signature under test (per plans/2026-09-08_structured-output-oob-delivery/spec.md):
 *   deliverOobStructuredResponse(opts: {
 *     structuredResponse: string;
 *     respondTo: string;
 *     childSessionId?: string;
 *     ext: SubagentRuntimeExtension;
 *     subLog: Logger;
 *     maxChars?: number;
 *     hasSender: boolean;
 *   }): Promise<void>;
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  registerSteerChannel,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

describe("deliverOobStructuredResponse", () => {
  const mockPostToOperator = vi.fn();

  beforeEach(() => {
    _resetAllChannels();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetAllChannels();
  });

  const ext = (overrides: Record<string, unknown> = {}) =>
    ({
      postToOperator: mockPostToOperator,
      runSessionModelTurn: vi.fn(),
      ...overrides,
    }) as never;

  const opts = (overrides: Record<string, unknown> = {}) => ({
    childSessionId: "child-oob",
    respondTo: "parent-oob",
    maxChars: 8000,
    subLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ext: ext(),
    ...overrides,
  });

  it("delivers both to_operator and to_sender when both fields are present", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const postToOperator = mockPostToOperator;
    const operatorText = "Message for the operator";
    const senderText = "Message for the sender";

    const handle = registerSteerChannel("parent-oob");

    await deliverOobStructuredResponse({
      ...opts(),
      structuredResponse: JSON.stringify({
        to_operator: operatorText,
        to_sender: senderText,
      }),
      hasSender: true,
    });

    expect(postToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        userContent: expect.stringContaining(operatorText),
      }),
    );
    const steers = drainSteers("parent-oob");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain(senderText);
    handle.unregister();
  });

  it("delivers only to_sender when to_operator is null", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const senderText = "Only sender gets this";
    const handle = registerSteerChannel("parent-oob");

    await deliverOobStructuredResponse({
      ...opts(),
      structuredResponse: JSON.stringify({
        to_operator: null,
        to_sender: senderText,
      }),
      hasSender: true,
    });

    expect(mockPostToOperator).not.toHaveBeenCalled();
    const steers = drainSteers("parent-oob");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain(senderText);
    handle.unregister();
  });

  it("delivers only to_operator when to_sender is null", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const operatorText = "Only operator gets this";

    await deliverOobStructuredResponse({
      ...opts(),
      structuredResponse: JSON.stringify({
        to_operator: operatorText,
        to_sender: null,
      }),
      hasSender: true,
    });

    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.stringContaining(operatorText),
      }),
    );
  });

  it("does not deliver anything when both fields are null", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    await deliverOobStructuredResponse({
      ...opts(),
      structuredResponse: JSON.stringify({ to_operator: null, to_sender: null }),
      hasSender: true,
    });

    expect(mockPostToOperator).not.toHaveBeenCalled();
    expect(drainSteers("parent-oob")).toHaveLength(0);
  });

  it("sends a nudge turn when JSON is invalid, and surfaces error when nudge produces no response", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const warn = vi.fn();
    const error = vi.fn();
    const runTurn = vi.fn().mockResolvedValue(undefined);

    await deliverOobStructuredResponse({
      ...opts({
        subLog: { info: vi.fn(), warn, error },
        ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      }),
      structuredResponse: "not valid json",
      hasSender: true,
    });

    expect(warn).toHaveBeenCalled();
    // Nudge turn was called with structured output schema
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        modelInvocationOverride: expect.objectContaining({
          responseSchema: expect.objectContaining({ schema: expect.any(Object) }),
          structuredOutputMode: "best-effort",
        }),
      }),
    );
    // Error surfaced to operator
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        userContent: expect.stringContaining("Error"),
      }),
    );
    expect(drainSteers("parent-oob")).toHaveLength(0);
  });

  it("recovers when nudge turn produces valid structured output (hasSender=true)", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const nudgeResponse = JSON.stringify({
      to_operator: "recovered!",
      to_sender: "back to sender",
    });
    const runTurn = vi.fn().mockResolvedValue({ latestAssistantText: nudgeResponse });
    const handle = registerSteerChannel("parent-oob");

    await deliverOobStructuredResponse({
      ...opts({
        ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      }),
      structuredResponse: "not valid json",
      hasSender: true,
    });

    // Nudge turn was called
    expect(runTurn).toHaveBeenCalled();
    // Recovery succeeded — operator and sender both delivered
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.stringContaining("recovered!"),
      }),
    );
    const steers = drainSteers("parent-oob");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("back to sender");
    handle.unregister();
  });

  it("recovers when nudge turn produces valid structured output (hasSender=false, timer case)", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const nudgeResponse = JSON.stringify({ to_operator: "timer result" });
    const runTurn = vi.fn().mockResolvedValue({ latestAssistantText: nudgeResponse });

    await deliverOobStructuredResponse({
      ...opts({
        ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      }),
      structuredResponse: "not valid json",
      hasSender: false,
    });

    expect(runTurn).toHaveBeenCalled();
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.stringContaining("timer result"),
      }),
    );
  });

  it("surfaces error to operator when nudge also produces invalid JSON", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const error = vi.fn();
    const runTurn = vi.fn().mockResolvedValue({ latestAssistantText: "still not json" });

    await deliverOobStructuredResponse({
      ...opts({
        subLog: { info: vi.fn(), warn: vi.fn(), error },
        ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      }),
      structuredResponse: "not valid json",
      hasSender: true,
    });

    expect(runTurn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        userContent: expect.stringContaining("Error"),
      }),
    );
  });

  it("surfaces error to operator when nudge turn itself throws", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const error = vi.fn();
    const runTurn = vi.fn().mockRejectedValue(new Error("model unavailable"));

    await deliverOobStructuredResponse({
      ...opts({
        subLog: { info: vi.fn(), warn: vi.fn(), error },
        ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      }),
      structuredResponse: "not valid json",
      hasSender: false,
    });

    expect(runTurn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        userContent: expect.stringContaining("Error"),
      }),
    );
  });

  it("truncates long messages to maxChars", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const longText = "x".repeat(10000);
    const handle = registerSteerChannel("parent-oob");

    await deliverOobStructuredResponse({
      ...opts({ maxChars: 100 }),
      structuredResponse: JSON.stringify({ to_operator: longText, to_sender: longText }),
      hasSender: true,
    });

    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.stringContaining("x".repeat(100)),
      }),
    );
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.not.stringContaining("x".repeat(101)),
      }),
    );
    const steers = drainSteers("parent-oob");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("x".repeat(100));
    expect(steers[0]).not.toContain("x".repeat(101));
    handle.unregister();
  });

  it("falls back to runSessionModelTurn when no active steer channel for to_sender", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const runTurn = vi.fn().mockResolvedValue({});
    const senderText = "Sender fallback message";

    await deliverOobStructuredResponse({
      ...opts(),
      ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      structuredResponse: JSON.stringify({
        to_operator: null,
        to_sender: senderText,
      }),
      hasSender: true,
    });

    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-oob",
        userContent: expect.stringContaining(senderText),
        userMetadata: expect.objectContaining({
          subagent_result: true,
          child_session_id: "child-oob",
        }),
      }),
    );
  });

  it("does NOT deliver to_sender when hasSender is false even if present", async () => {
    const { deliverOobStructuredResponse } = await import("../../src/control/integration-ops");

    const runTurn = vi.fn().mockResolvedValue({});

    await deliverOobStructuredResponse({
      ...opts(),
      ext: { postToOperator: mockPostToOperator, runSessionModelTurn: runTurn } as never,
      structuredResponse: JSON.stringify({
        to_operator: null,
        to_sender: "should not be delivered",
      }),
      hasSender: false,
    });

    // No sender delivery attempt
    expect(runTurn).not.toHaveBeenCalled();
    expect(drainSteers("parent-oob")).toHaveLength(0);
    // Operator not posted because to_operator was null
    expect(mockPostToOperator).not.toHaveBeenCalled();
  });

  it("is invoked by deliverSubagentResult after the queue-path model turn", async () => {
    // This test is behavioral: we replace runSessionModelTurn with a mock that
    // returns a structured response, then verify postToOperator receives the
    // to_operator field. deliverOobStructuredResponse is a same-module call,
    // so vi.mock cannot intercept it — we test the effect.
    const { deliverSubagentResult } = await import("../../src/control/integration-ops");

    const structured = JSON.stringify({
      to_operator: "operator sees this",
      to_sender: "sender sees this",
    });
    const runTurn = vi.fn().mockResolvedValue({ latestAssistantText: structured });
    const handle = registerSteerChannel("parent-oob");

    await deliverSubagentResult(
      { runSessionModelTurn: runTurn, postToOperator: mockPostToOperator } as never,
      {
        childSessionId: "child-oob",
        respondTo: "parent-oob",
        internalDelivery: true,
        mode: "persistent",
        deliveryMode: "queue",
        assistantText: "Original subagent result",
        subLog: { info: vi.fn(), warn: vi.fn() } as never,
      },
    );

    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelInvocationOverride: expect.objectContaining({
          responseSchema: expect.objectContaining({
            schema: expect.objectContaining({
              type: "object",
              required: expect.arrayContaining(["to_operator", "to_sender"]),
            }),
          }),
          structuredOutputMode: "best-effort",
        }),
      }),
    );
    expect(mockPostToOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: expect.stringContaining("operator sees this"),
      }),
    );
    const steers = drainSteers("parent-oob");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("sender sees this");
    handle.unregister();
  });
});
