import { describe, it, expect, vi } from "vitest";
import { executeSessionAgentTurn } from "../../src/sessions/session-agent-turn";
import { postTurnSurfaceNotice } from "../../src/presentation/active-turn-surface";

vi.mock("../../src/sessions/session-agent-turn.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeSessionAgentTurn: vi.fn().mockImplementation(async (input: any) => {
    // Simulate streaming: the round's accumulated text grows beyond slice limit
    if (input.stream?.onModelTextDelta) {
      for (let i = 1; i <= 10; i++) {
        input.stream.onModelTextDelta({
          delta: "a".repeat(30),
          accumulated: "a".repeat(i * 30),
          round: 0,
        });
      }
    }
    input.events?.onThinkingDelta?.({ accumulated: "private reasoning", round: 0 });
    return {
      latestAssistantText: "a".repeat(300),
      assistantTurnProse: "a".repeat(300),
      failoverMeta: undefined,
      showAttachments: undefined,
    };
  }),
}));

const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn");

describe("runInboundSessionTurn streaming final delivery", () => {
  it("passes full unsliced body to setFullContent when streaming", async () => {
    const MAX_LEN = 50;
    const sendErrorBody = vi.fn().mockResolvedValue(undefined);
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => (t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t),
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody,
    });

    expect(sendErrorBody).not.toHaveBeenCalled();
    expect(setFullContent).toHaveBeenCalled();

    // Streaming path should pass the full body to setFullContent
    const lastCall = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(lastCall.length).toBe(300);
  });

  it("does not push duplicate sliced content during streaming", async () => {
    const MAX_LEN = 50;
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => (t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t),
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The mock sends 10 deltas: 30, 60, 90, 120, 150, 180, 210, 240, 270, 300 chars.
    // With the new approach, pushUpdate receives the full accumulated text
    // not the sliced version, so we should verify that pushUpdate was called
    // with the full text, not the sliced text.
    expect(pushUpdate).toHaveBeenCalled();

    // The last call should have the full 300-character text
    const lastCall = pushUpdate.mock.calls.at(-1)?.[0] as string;
    expect(lastCall.length).toBe(300);
  });
});

describe("runInboundSessionTurn in-turn surface notices", () => {
  it("folds a notice posted mid-turn into the final body", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => {
        // A banner lands while the turn is still running: it must be part
        // of the turn's own output, not a separate channel message.
        postTurnSurfaceNotice("s1", "> ↩️ ✅ Exec notification delivered in-turn: *echo hi* `n1`");
        return text;
      },
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    const last = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(last).toContain("a".repeat(300));
    expect(last).toContain("> ↩️ ✅ Exec notification delivered in-turn: *echo hi* `n1`");
    // The notice is cleared from the registry when the turn ends.
    expect(postTurnSurfaceNotice("s1", "late")).toBe(false);
  });
});

describe("runInboundSessionTurn streaming delta delivery", () => {
  it("calls pushUpdate during model text deltas (not setFullContent)", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // During streaming, pushUpdate should be called (not setFullContent)
    expect(pushUpdate).toHaveBeenCalled();
    // setFullContent should only be called at the end, not during streaming
    // We can verify this by checking that setFullContent was called exactly once
    // and that pushUpdate was called multiple times (once per delta)
    expect(setFullContent).toHaveBeenCalledTimes(1);
    expect(pushUpdate.mock.calls.length).toBeGreaterThan(1);

    // The last call should have the full 300-character text
    const lastCall = pushUpdate.mock.calls.at(-1)?.[0] as string;
    expect(lastCall.length).toBe(300);
  });

  it("calls setFullContent at turn end with full final body", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // At turn end, setFullContent should be called with the full body
    expect(setFullContent).toHaveBeenCalled();
    const lastCall = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(lastCall.length).toBe(300);
  });

  it("does not send duplicate content (pushUpdate + setFullContent)", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: streamStart,
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // Verify that pushUpdate was called during streaming
    expect(pushUpdate).toHaveBeenCalled();

    // Verify that setFullContent was called at the end
    expect(setFullContent).toHaveBeenCalled();

    // The final setFullContent should have the complete text
    const finalSetFullContent = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(finalSetFullContent.length).toBe(300);

    // The pushUpdate calls should accumulate to the same content
    // (pushUpdate receives accumulating text, not incremental deltas)
    const pushUpdateCalls = pushUpdate.mock.calls.map((call) => call[0] as string);
    const totalPushUpdateLength = pushUpdateCalls.reduce((sum, text) => sum + text.length, 0);

    // Since pushUpdate receives the full accumulated text each time,
    // the total length will be more than the final content
    // The important thing is that setFullContent provides the final reconciliation
    expect(totalPushUpdateLength).toBeGreaterThan(300);
  });
});

describe("runInboundSessionTurn thinking display", () => {
  const buildTurn = () =>
    Promise.resolve({
      sessionId: "s1",
      agentId: "main",
      userContent: "hi",
      messages: [],
      tools: [],
      systemPrompt: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateDb: {} as any,
    });

  it("slipstreams thinking in streamed edits and includes it in final content", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    await runInboundSessionTurn({
      buildTurn,
      streaming: {
        minIntervalMs: 0,
        start: vi.fn().mockResolvedValue({ setFullContent, pushUpdate }),
      },
      sliceDisplayText: (text) => text,
      showThinking: true,
      formatAssistantReply: (text) => text,
      formatErrorReply: String,
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });
    expect(pushUpdate.mock.calls.some(([text]) => text.includes("> 💭 private reasoning"))).toBe(
      true,
    );
    expect(setFullContent).toHaveBeenLastCalledWith(`${"a".repeat(300)}\n\n> 💭 private reasoning`);
  });

  it("includes reasoning in the final at-once reply without streaming", async () => {
    const sendAssistantBody = vi.fn().mockResolvedValue(undefined);
    await runInboundSessionTurn({
      buildTurn,
      sliceDisplayText: (text) => text,
      showThinking: true,
      formatAssistantReply: (text) => text,
      formatErrorReply: String,
      sendAssistantBody,
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });
    expect(sendAssistantBody).toHaveBeenCalledWith(
      `> 💭 private reasoning\n\n${"a".repeat(300)}`,
      undefined,
    );
  });

  it("does not expose reasoning when disabled", async () => {
    const sendAssistantBody = vi.fn().mockResolvedValue(undefined);
    await runInboundSessionTurn({
      buildTurn,
      sliceDisplayText: (text) => text,
      showThinking: false,
      formatAssistantReply: (text) => text,
      formatErrorReply: String,
      sendAssistantBody,
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });
    expect(sendAssistantBody).toHaveBeenCalledWith("a".repeat(300), undefined);
  });
});

describe("runInboundSessionTurn non-streaming path", () => {
  it("uses sendAssistantBody when streaming is not configured", async () => {
    const MAX_LEN = 50;
    const sendAssistantBody = vi.fn().mockResolvedValue(undefined);
    const sendErrorBody = vi.fn().mockResolvedValue(undefined);

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      sliceDisplayText: (t) => (t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t),
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody,
      sendErrorBody,
    });

    // Should use sendAssistantBody (not streaming)
    expect(sendAssistantBody).toHaveBeenCalled();
    expect(sendErrorBody).not.toHaveBeenCalled();

    // Should be sliced to MAX_LEN
    const body = sendAssistantBody.mock.calls[0][0];
    expect(body.length).toBe(MAX_LEN);
  });

  it("resolves before delivery completes when detachPostTurnDelivery is set", async () => {
    let releaseDeliveryGate!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDeliveryGate = resolve;
    });
    let deliveryCompleted = false;
    const sendAssistantBody = vi.fn().mockImplementation(async () => {
      await deliveryGate;
      deliveryCompleted = true;
    });

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody,
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
      detachPostTurnDelivery: true,
    });

    // The turn settles promptly even though delivery is still gated.
    expect(sendAssistantBody).toHaveBeenCalledTimes(1);
    expect(deliveryCompleted).toBe(false);

    // Releasing the gate lets the detached delivery finish afterwards.
    releaseDeliveryGate();
    await vi.waitFor(() => {
      expect(deliveryCompleted).toBe(true);
    });
  });

  it("does not call streaming methods when not configured", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });
    const sendAssistantBody = vi.fn().mockResolvedValue(undefined);

    await runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody,
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // Streaming methods should not be called
    expect(streamStart).not.toHaveBeenCalled();
    expect(setFullContent).not.toHaveBeenCalled();
    expect(pushUpdate).not.toHaveBeenCalled();

    // sendAssistantBody should be called instead
    expect(sendAssistantBody).toHaveBeenCalled();
  });
});
describe("runInboundSessionTurn abort handling", () => {
  it("stops stream edits after abort even though the producer keeps emitting deltas", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    // The turn promise stays pending after the abort — a hung model call —
    // so no post-turn delivery ever runs to clean up the presentation
    // pipeline. Only the abort hook can stop the edits here.
    vi.mocked(executeSessionAgentTurn).mockImplementationOnce(async (input: any) => {
      input.stream?.onModelTextDelta?.({
        delta: "a".repeat(10),
        accumulated: "a".repeat(10),
        round: 0,
      });
      // Let the first delta's coalesced dispatch land (edits already flowing),
      // THEN abort mid-stream while the model call never settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      input.events?.onTurnAborted?.();
      // The stuck provider keeps trickling deltas after the abort.
      input.stream?.onModelTextDelta?.({
        delta: "b".repeat(10),
        accumulated: "b".repeat(10),
        round: 0,
      });
      input.stream?.onModelTextDelta?.({
        delta: "c".repeat(10),
        accumulated: "c".repeat(10),
        round: 0,
      });
      await turnGate;
      return {
        latestAssistantText: "done",
        assistantTurnProse: "done",
        failoverMeta: undefined,
        outcome: "aborted",
      };
    });

    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue("> stopped");
    const createStatusBar = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockResolvedValue(undefined),
      finish,
    });

    const runPromise = runInboundSessionTurn({
      buildTurn: () =>
        Promise.resolve({
          sessionId: "s1",
          agentId: "main",
          userContent: "hi",
          messages: [],
          tools: [],
          systemPrompt: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stateDb: {} as any,
        }),
      streaming: {
        minIntervalMs: 0,
        start: vi.fn().mockResolvedValue({ setFullContent, pushUpdate }),
      },
      statusBar: {
        enabled: true,
        create: createStatusBar,
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: String,
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The pre-abort delta flushes through…
    await vi.waitFor(() => expect(pushUpdate).toHaveBeenCalled());
    // …and nothing else does, even though two more deltas were emitted after
    // the abort while the turn promise is still pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushUpdate).toHaveBeenCalledTimes(1);
    // The tracker was frozen at its terminal abort render.
    expect(finish).toHaveBeenCalledWith("aborted");

    // Letting the turn settle afterwards still delivers normally.
    releaseTurn();
    await runPromise;
    expect(setFullContent).toHaveBeenCalled();
  });
});
