/**
 * Tests the dead-target fallback in deliverSubagentResult (integration-ops.ts).
 * When the respond_to session cannot run a turn, the result is re-routed to the
 * spawning session with a labeled header instead of being silently dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { _resetAllChannels } from "../../src/sessions/steer-channel";

describe("deliverSubagentResult fallback", () => {
  beforeEach(() => {
    _resetAllChannels();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetAllChannels();
  });

  it("re-routes to fallbackRespondTo with a labeled header when respond_to is dead", async () => {
    const runSessionModelTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("session not available: dead-target"))
      .mockResolvedValueOnce({});
    const subLog = { info: vi.fn(), warn: vi.fn() } as never;
    const { deliverSubagentResult } = await import("../../src/control/integration-ops");

    await deliverSubagentResult({ runSessionModelTurn } as never, {
      childSessionId: "child-f1",
      respondTo: "dead-target",
      fallbackRespondTo: "spawning-parent",
      internalDelivery: true,
      mode: "one_shot",
      deliveryMode: "queue",
      assistantText: "substantive report",
      subLog,
    });

    expect(runSessionModelTurn).toHaveBeenCalledTimes(2);
    expect(runSessionModelTurn.mock.calls[0][0].sessionId).toBe("dead-target");
    expect(runSessionModelTurn.mock.calls[1][0].sessionId).toBe("spawning-parent");
    expect(runSessionModelTurn.mock.calls[1][0].userContent).toContain(
      "[Subagent completed — respond_to dead-target unavailable] session_id: `child-f1`",
    );
    expect(runSessionModelTurn.mock.calls[1][0].userContent).toContain("substantive report");
  });

  it("drops with a logged warning when both respond_to and the fallback are unavailable", async () => {
    const runSessionModelTurn = vi.fn().mockRejectedValue(new Error("session not available"));
    const subLog = { info: vi.fn(), warn: vi.fn() } as never;
    const { deliverSubagentResult } = await import("../../src/control/integration-ops");

    await deliverSubagentResult({ runSessionModelTurn } as never, {
      childSessionId: "child-f2",
      respondTo: "dead-target",
      fallbackRespondTo: "also-dead",
      internalDelivery: true,
      mode: "one_shot",
      deliveryMode: "queue",
      assistantText: "report",
      subLog,
    });

    // One attempt on respond_to, one on the fallback; no third attempt.
    expect(runSessionModelTurn).toHaveBeenCalledTimes(2);
    expect((subLog as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      "subagent result dropped: no live delivery target",
      expect.objectContaining({ childSessionId: "child-f2" }),
    );
  });

  it("does not fall back when no fallbackRespondTo is supplied", async () => {
    const runSessionModelTurn = vi.fn().mockRejectedValue(new Error("session not available"));
    const subLog = { info: vi.fn(), warn: vi.fn() } as never;
    const { deliverSubagentResult } = await import("../../src/control/integration-ops");

    await deliverSubagentResult({ runSessionModelTurn } as never, {
      childSessionId: "child-f3",
      respondTo: "dead-target",
      internalDelivery: true,
      mode: "persistent",
      deliveryMode: "queue",
      assistantText: "report",
      subLog,
    });

    expect(runSessionModelTurn).toHaveBeenCalledTimes(1);
  });

  it("uses the plain header when delivery to respond_to succeeds", async () => {
    const runSessionModelTurn = vi.fn().mockResolvedValue({});
    const subLog = { info: vi.fn(), warn: vi.fn() } as never;
    const { deliverSubagentResult } = await import("../../src/control/integration-ops");

    await deliverSubagentResult({ runSessionModelTurn } as never, {
      childSessionId: "child-f4",
      respondTo: "live-target",
      fallbackRespondTo: "spawning-parent",
      internalDelivery: true,
      mode: "one_shot",
      deliveryMode: "queue",
      assistantText: "report",
      subLog,
    });

    expect(runSessionModelTurn).toHaveBeenCalledTimes(1);
    expect(runSessionModelTurn.mock.calls[0][0].userContent).toContain(
      "[Subagent completed] session_id: `child-f4`",
    );
  });
});
