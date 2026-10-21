import { describe, it, expect, vi } from "vitest";
import { runInboundSessionTurn } from "../../src/messaging/inbound-session-turn";

type ExecuteSessionAgentTurnInput = Parameters<
  typeof import("../../src/sessions/session-agent-turn").executeSessionAgentTurn
>[0];

// DI: inject executeSessionAgentTurn via options instead of mocking the module
// (import-order dependent under --no-isolate).
let fail = false;

const mockExecuteSessionAgentTurn = vi
  .fn()
  .mockImplementation(async (input: ExecuteSessionAgentTurnInput) => {
    if (fail) throw new Error("boom");
    if (input.stream?.onModelTextDelta) {
      for (let i = 1; i <= 10; i++) {
        input.stream.onModelTextDelta({
          delta: "a".repeat(30),
          accumulated: "a".repeat(i * 30),
          round: 0,
        });
      }
    }
    input.events?.onContextUpdate?.({ currentTokens: 12_345, totalTokens: 100_000 });
    input.events?.onSubagentsChanged?.({ total: 1, persistent: 1 });
    input.events?.onTimersChanged?.(4);
    return {
      latestAssistantText: "a".repeat(300),
      assistantTurnProse: "a".repeat(300),
      failoverMeta: undefined,
      showAttachments: undefined,
      outcome: "completed",
    };
  });

// Default turn builder shared across tests. `config`/`stateDb` are unused by
// the status-bar paths under test, so stubs (repo convention) suffice here.
function defaultBuildTurn() {
  return Promise.resolve({
    sessionId: "s1",
    agentId: "main",
    userContent: "hi",
    messages: [],
    tools: [],
    systemPrompt: "",
    config: {} as never,
    stateDb: {} as never,
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
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
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

    // Exactly one streaming start per turn — a double start orphans a handle.
    expect(streamStart).toHaveBeenCalledTimes(1);

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
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
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
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
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

  it("(d) attachSink wraps the stream handle after start; live pushes reach it", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const handle: {
      setFullContent: typeof setFullContent;
      pushUpdate: typeof pushUpdate;
      setStatusBar?: (line: string | null) => Promise<void>;
    } = { setFullContent, pushUpdate };
    const streamStart = vi.fn().mockResolvedValue(handle);

    // Mimics the platform dep: attachSink augments the handle in place with a
    // live setStatusBar sink.
    const liveStatusBar = vi.fn().mockResolvedValue(undefined);
    const attachSink = vi.fn().mockImplementation((h: typeof handle) => {
      h.setStatusBar = liveStatusBar;
      return h;
    });

    const finish = vi.fn().mockResolvedValue("✅ bar");
    let capturedTracker:
      | {
          setStatusBar: (line: string | null) => Promise<void>;
          finish: (outcome: string) => Promise<string | undefined>;
        }
      | undefined;
    const create = vi.fn().mockImplementation(async () => {
      capturedTracker = {
        // Lazy binding: by the time the turn pushes, attachSink has wrapped the
        // handle, so the live setter exists.
        setStatusBar: (line) => handle.setStatusBar?.(line) ?? Promise.resolve(),
        finish,
      };
      return capturedTracker;
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create, attachSink },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The handle gained setStatusBar via attachSink right after streaming start.
    expect(attachSink).toHaveBeenCalledTimes(1);
    expect(attachSink.mock.calls[0]?.[0]).toBe(handle);
    expect(handle.setStatusBar).toBe(liveStatusBar);

    // A live mid-turn push through the tracker reaches the wrapped handle sink.
    await capturedTracker?.setStatusBar("🧠 live");
    expect(liveStatusBar).toHaveBeenCalledWith("🧠 live");
  });

  it("(e) streaming lifecycle: in-flight bar cleared before final delivery, exactly one bar delivered", async () => {
    const BAR_LINE = "✅ ｜ 🔢 `1` ｜ 🔧 `0`";

    // Models streaming.ts handle behavior: setStatusBar remembers the bar as
    // active state and setFullContent re-applies it on top of the pushed text.
    const events: string[] = [];
    const deliveredBodies: string[] = [];
    let activeBar: string | null = null;
    const handle = {
      async setFullContent(text: string): Promise<void> {
        deliveredBodies.push(activeBar === null ? text : `${text}\n\n${activeBar}`);
        events.push("setFullContent");
      },
      async pushUpdate(): Promise<void> {
        events.push("pushUpdate");
      },
      async setStatusBar(line: string | null): Promise<void> {
        activeBar = line;
        events.push(`setStatusBar(${line === null ? "null" : "bar"})`);
      },
    };
    const streamStart = vi.fn().mockResolvedValue(handle);

    // PR #394 attachSink: the platform augments the in-flight handle with the
    // live bar sink. The raw handle already models streaming.ts's native
    // setter, so pass it through unchanged.
    const attachSink = vi.fn().mockImplementation((h: typeof handle) => h);

    // The tracker's terminal render flows through the sink into the handle's
    // setStatusBar (leaving the bar active) and finish() returns the line that
    // delivery appends to the body.
    const finish = vi.fn().mockImplementation(async () => {
      await handle.setStatusBar(BAR_LINE);
      return BAR_LINE;
    });
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockImplementation((line: string | null) => handle.setStatusBar(line)),
      finish,
    });

    const sendAssistantBody = vi.fn().mockResolvedValue(undefined);
    const sendErrorBody = vi.fn().mockResolvedValue(undefined);

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create, attachSink },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody,
      sendErrorBody,
    });

    // (c) The turn completes normally on the streaming delivery path.
    expect(finish).toHaveBeenCalledWith("completed");
    expect(sendErrorBody).not.toHaveBeenCalled();
    expect(sendAssistantBody).not.toHaveBeenCalled();
    expect(deliveredBodies.length).toBeGreaterThan(0);

    // (a) The final flush still carries the active terminal bar (bar visible up
    // to the last moment), then the clear (setStatusBar(null), state-only) lands
    // between the flush and the final setFullContent delivery edit.
    const flushedAt = events.lastIndexOf("pushUpdate");
    const clearedAt = events.indexOf("setStatusBar(null)");
    const deliveredAt = events.lastIndexOf("setFullContent");
    expect(flushedAt).toBeGreaterThanOrEqual(0);
    expect(flushedAt).toBeLessThan(clearedAt);
    expect(clearedAt).toBeLessThan(deliveredAt);

    // (b) The delivered body carries exactly ONE bar line — no doubling.
    const finalBody = deliveredBodies.at(-1) ?? "";
    expect(finalBody.split(BAR_LINE).length - 1).toBe(1);
    expect(finalBody.endsWith(BAR_LINE)).toBe(true);

    // The handle's active bar state is cleared after the turn.
    expect(activeBar).toBeNull();
  });

  it("(f) error path: in-flight bar cleared before error delivery, exactly one bar in error body", async () => {
    const BAR_LINE = "❌ ｜ 🔢 `1` ｜ 🔧 `0`";

    const events: string[] = [];
    let activeBar: string | null = null;
    const handle = {
      async setFullContent(): Promise<void> {
        events.push("setFullContent");
      },
      async pushUpdate(): Promise<void> {
        events.push("pushUpdate");
      },
      async setStatusBar(line: string | null): Promise<void> {
        activeBar = line;
        events.push(`setStatusBar(${line === null ? "null" : "bar"})`);
      },
    };
    const streamStart = vi.fn().mockResolvedValue(handle);
    const attachSink = vi.fn().mockImplementation((h: typeof handle) => h);

    // The terminal ❌ render flows through the sink into the handle before the
    // error body is delivered.
    const finish = vi.fn().mockImplementation(async () => {
      await handle.setStatusBar(BAR_LINE);
      return BAR_LINE;
    });
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockImplementation((line: string | null) => handle.setStatusBar(line)),
      finish,
    });

    let errorBody = "";
    const sendErrorBody = vi.fn().mockImplementation(async (body: string) => {
      errorBody = body;
      events.push("sendErrorBody");
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: () => Promise.reject(new Error("boom")),
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create, attachSink },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody,
    });

    expect(finish).toHaveBeenCalledWith("failed");

    // The bar was cleared BEFORE the error body was delivered.
    const clearedAt = events.indexOf("setStatusBar(null)");
    const deliveredAt = events.indexOf("sendErrorBody");
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    expect(clearedAt).toBeLessThan(deliveredAt);

    expect(errorBody.split(BAR_LINE).length - 1).toBe(1);
    expect(errorBody.endsWith(BAR_LINE)).toBe(true);
    expect(activeBar).toBeNull();
  });

  it("(g) prose forwarding: stream text deltas reach tracker.onProse (💬 phase)", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const onProse = vi.fn();
    const finish = vi.fn().mockResolvedValue("✅ bar");
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockResolvedValue(undefined),
      finish,
      onProse,
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The mocked engine pushes 10 text deltas ("a"×30 … "a"×300); every raw
    // delta must reach the tracker so the live bar can flip to 💬 prose.
    expect(onProse).toHaveBeenCalledTimes(10);
    expect(onProse.mock.calls[0]?.[0]).toBe("a".repeat(30));
    expect(onProse.mock.calls.at(-1)?.[0]).toBe("a".repeat(300));
  });

  it("(h) context update forwarding: events.onContextUpdate reaches the tracker hook", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const onContextUpdate = vi.fn();
    const finish = vi.fn().mockResolvedValue("✅ bar");
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockResolvedValue(undefined),
      finish,
      onContextUpdate,
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The mocked turn reported provider usage once; it must reach the
    // tracker's context hook so the live bar's window section updates
    // mid-turn without a DB re-read.
    expect(onContextUpdate).toHaveBeenCalledTimes(1);
    expect(onContextUpdate).toHaveBeenCalledWith({ currentTokens: 12_345, totalTokens: 100_000 });
  });

  it("(i) subagent count forwarding: events.onSubagentsChanged reaches the tracker hook", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const onSubagentsChanged = vi.fn();
    const finish = vi.fn().mockResolvedValue("✅ bar");
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockResolvedValue(undefined),
      finish,
      onSubagentsChanged,
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The mocked turn spawned a subagent mid-turn; the fresh counts must
    // reach the tracker's hook so the live bar updates in the SAME turn.
    expect(onSubagentsChanged).toHaveBeenCalledTimes(1);
    expect(onSubagentsChanged).toHaveBeenCalledWith({ total: 1, persistent: 1 });
  });

  it("(j) timer count forwarding: events.onTimersChanged reaches the tracker hook", async () => {
    const setFullContent = vi.fn().mockResolvedValue(undefined);
    const pushUpdate = vi.fn().mockResolvedValue(undefined);
    const streamStart = vi.fn().mockResolvedValue({ setFullContent, pushUpdate });

    const onTimersChanged = vi.fn();
    const finish = vi.fn().mockResolvedValue("✅ bar");
    const create = vi.fn().mockResolvedValue({
      setStatusBar: vi.fn().mockResolvedValue(undefined),
      finish,
      onTimersChanged,
    });

    await runInboundSessionTurn({
      executeSessionAgentTurn: mockExecuteSessionAgentTurn,
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      statusBar: { enabled: true, create },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => String(err),
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody: vi.fn().mockResolvedValue(undefined),
    });

    // The mocked turn queued a timer mid-turn; the fresh count must reach
    // the tracker's hook so the live bar updates in the SAME turn.
    expect(onTimersChanged).toHaveBeenCalledTimes(1);
    expect(onTimersChanged).toHaveBeenCalledWith(4);
  });
});
