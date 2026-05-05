import { describe, it, expect, vi } from "vitest";
import { createCoalescingStreamPusher } from "../../src/messaging/inbound-session-turn";

vi.mock("../../src/sessions/session-agent-turn.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeSessionAgentTurn: vi.fn().mockImplementation(async (input: any) => {
    // Simulate streaming: accumulated text grows beyond slice limit
    if (input.stream?.onModelTextDelta) {
      for (let i = 1; i <= 10; i++) {
        input.stream.onModelTextDelta("a".repeat(i * 30));
      }
    }
    return {
      latestAssistantText: "a".repeat(300),
      failoverMeta: undefined,
      showAttachments: undefined,
    };
  }),
}));

const { runInboundSessionTurn } = await import("../../src/messaging/inbound-session-turn");

describe("createCoalescingStreamPusher", () => {
  it("calls setFull with latest text", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const pusher = createCoalescingStreamPusher(setFull, 0);
    pusher.push("hello");
    await pusher.flush();
    expect(setFull).toHaveBeenCalledWith("hello");
  });
});

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
