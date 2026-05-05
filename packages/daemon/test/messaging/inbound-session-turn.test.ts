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
