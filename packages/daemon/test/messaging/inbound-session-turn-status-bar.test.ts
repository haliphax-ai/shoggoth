import { describe, it, expect, vi } from "vitest";
import { runInboundSessionTurn } from "../../src/messaging/inbound-session-turn";

vi.mock("../../src/sessions/session-agent-turn.js", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fail = false;
  return {
    __setFail: (v: boolean) => {
      fail = v;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeSessionAgentTurn: vi.fn().mockImplementation(async (input: any) => {
      if (fail) throw new Error("boom");
      if (input.stream?.onModelTextDelta) {
        for (let i = 1; i <= 10; i++) {
          input.stream.onModelTextDelta("a".repeat(i * 30));
        }
      }
      return {
        latestAssistantText: "a".repeat(300),
        failoverMeta: undefined,
        showAttachments: undefined,
        outcome: "completed",
      };
    }),
  };
});

// Default turn builder shared across tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultBuildTurn() {
  return Promise.resolve({
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
}

describe("runInboundSessionTurn status bar", () => {
  it("(a) streaming completed lifecycle: final setFullContent carries the rendered bar line", async () => {
    const BAR_LINE = "✅ ｜ 🔢 `1` ｜ 🔧 `0`";
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const setStatusBar = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(BAR_LINE);
    const create = vi.fn().mockResolvedValue({ setStatusBar, finish });

    await runInboundSessionTurn({
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The tracker factory is wired and finish() returns the rendered bar line.
    expect(create).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith("completed");

    // The final setFullContent carries the rendered bar line appended to the body.
    const lastCall = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain(BAR_LINE);
  });

  it("(b) disabled config: factory never invoked, zero sink calls, behavior unchanged", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const create = vi.fn();
    const setStatusBar = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue("✅ ｜ 🔢 `1`");

    await runInboundSessionTurn({
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: false, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // Disabled: the factory must never be invoked and no sink calls are made.
    expect(create).not.toHaveBeenCalled();
    expect(setStatusBar).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();

    // Behavior unchanged: normal streaming delivery still happens.
    expect(setFullContent).toHaveBeenCalled();
    const lastCall = setFullContent.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain("aaaa");
  });

  it("(c) non-messaging-surface delivery: no tracker, no sink calls", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    // The factory models a delivery that is NOT messaging_surface: create resolves
    // to undefined, so no tracker exists and no sink calls may be made.
    const create = vi.fn().mockResolvedValue(undefined);
    const setStatusBar = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn();

    await runInboundSessionTurn({
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // No tracker sink calls may happen for non-messaging-surface delivery.
    expect(setStatusBar).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();

    // Normal streaming delivery still succeeds untouched.
    expect(setFullContent).toHaveBeenCalled();
  });
});
