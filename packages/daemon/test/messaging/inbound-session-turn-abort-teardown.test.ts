import { describe, it, expect, vi } from "vitest";
import { runInboundSessionTurn } from "../../src/messaging/inbound-session-turn";
import {
  createStatusBarTurnTracker,
  type TurnStatusBarTracker,
} from "../../src/presentation/status-bar";
import { DEFAULT_STATUS_BAR_CONFIG } from "@shoggoth/shared";

type ExecuteSessionAgentTurnInput = Parameters<
  typeof import("../../src/sessions/session-agent-turn").executeSessionAgentTurn
>[0];

type TurnResult = {
  latestAssistantText: string;
  assistantTurnProse?: string;
  failoverMeta?: unknown;
  showAttachments?: unknown;
  outcome: "finished" | "aborted" | "failed" | string;
};

vi.mock("../../src/sessions/session-agent-turn.js", () => {
  let impl: ((input: ExecuteSessionAgentTurnInput) => Promise<TurnResult>) | undefined;
  return {
    __setImpl: (fn: (input: ExecuteSessionAgentTurnInput) => Promise<TurnResult>) => {
      impl = fn;
    },
    executeSessionAgentTurn: vi
      .fn()
      .mockImplementation(async (input: ExecuteSessionAgentTurnInput) => {
        if (!impl) throw new Error("test must install an impl via __setImpl");
        return impl(input);
      }),
  };
});

const { __setImpl } = await import("../../src/sessions/session-agent-turn.js");

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

/**
 * Fake stream handle mirroring the platform contract: after close(), every
 * operation is a no-op that never reaches the transport. Tracks effective
 * (pre-close) edits vs. post-close attempts separately so tests can assert
 * "zero platform traffic after the abort".
 */
function createFakeStreamHandle() {
  const state = {
    closed: false,
    effectiveEdits: 0,
    postCloseAttempts: 0,
  };
  const gated = (after?: () => void) => async (): Promise<void> => {
    if (state.closed) {
      state.postCloseAttempts += 1;
      return;
    }
    state.effectiveEdits += 1;
    after?.();
  };
  return {
    state,
    setFullContent: vi.fn(gated()),
    pushUpdate: vi.fn(gated()),
    setStatusBar: vi.fn(gated()),
    close: vi.fn(() => {
      state.closed = true;
    }),
  };
}

/** Turn-orchestrator-style statusBar wiring around the REAL tracker. */
function buildStatusBarOption(handle: { setStatusBar: (line: string | null) => Promise<void> }) {
  let tracker: TurnStatusBarTracker | undefined;
  const finishSpy = vi.fn(async (outcome: string) =>
    tracker!.finish(outcome === "aborted" || outcome === "failed" ? outcome : "finished"),
  );
  return {
    finishSpy,
    option: {
      enabled: true,
      attachSink: (h: typeof handle) => {
        tracker?.attachSink({ setStatusBar: (line) => h.setStatusBar(line) });
        return h;
      },
      create: async () => {
        tracker = createStatusBarTurnTracker({
          cfg: { ...DEFAULT_STATUS_BAR_CONFIG, enabled: true },
          render: (snap) => `${snap.phase}#t${snap.toolCalls.total}`,
          stats: { sequence: 1, compactions: 0 },
          minIntervalMs: 50,
        });
        return {
          setStatusBar: (line: string | null) => tracker!.setStatusBar(line),
          finish: finishSpy,
          onProse: (accumulated: string) => tracker?.onProse?.(accumulated),
          onThinkingDelta: (accumulated: string) => tracker?.onThinkingDelta?.(accumulated),
          onToolCall: (ev: Parameters<NonNullable<TurnStatusBarTracker["onToolCall"]>>[0]) =>
            tracker?.onToolCall?.(ev),
          onCompaction: () => tracker?.onCompaction?.(),
          onContextUpdate: (u: { currentTokens: number; totalTokens?: number }) =>
            tracker?.onContextUpdate?.(u),
          onSubagentsChanged: (c: { total: number; persistent: number }) =>
            tracker?.onSubagentsChanged?.(c),
          onTimersChanged: (count: number) => tracker?.onTimersChanged?.(count),
          onNotifiesChanged: (count: number) => tracker?.onNotifiesChanged?.(count),
        };
      },
    },
  };
}

describe("runInboundSessionTurn abort teardown", () => {
  it("abort racing turn setup: onTurnAborted still stops the pusher, finishes the tracker, and closes the handle — zero edits after the abort", async () => {
    vi.useFakeTimers();
    try {
      const handle = createFakeStreamHandle();
      const streamStart = vi.fn().mockResolvedValue(handle);
      const { finishSpy, option: statusBar } = buildStatusBarOption(handle);
      // Effective edits observed at the moment of the abort; the invariant is
      // "nothing new reaches the platform AFTER this point".
      let editsAtAbort = -1;

      // Models the Hole A scenario end-to-end: the turn's AbortSignal was
      // already aborted while setup dragged (slow provider), so the
      // notifyOnTurnAbort guard fires onTurnAborted synchronously at turn
      // entry. A live bar render was already scheduled before the abort, and
      // a hung stream keeps emitting deltas afterwards.
      __setImpl(async (input) => {
        // 1. Live turn: prose arrives, scheduling tracker/pusher renders.
        input.stream?.onModelTextDelta?.({ delta: "x", accumulated: "hello", round: 0 });
        await vi.advanceTimersByTimeAsync(60); // tracker render (50ms) lands on the handle
        // 2. Abort fires (already-aborted guard) — synchronously, mid-setup.
        input.events?.onTurnAborted?.();
        // Flush the microtask/timer queue so any pre-abort dispatch that was
        // already in flight lands, then snapshot the effective-edit count.
        await vi.advanceTimersByTimeAsync(0);
        editsAtAbort = handle.state.effectiveEdits;
        // 3. The hung model stream keeps emitting deltas after the abort.
        input.stream?.onModelTextDelta?.({
          delta: "y",
          accumulated: "hello world, late",
          round: 0,
        });
        await vi.advanceTimersByTimeAsync(10_000); // any leaked timer fires NOW
        // 4. Deferred settle (e.g. abort deferred until compaction timed out).
        return {
          latestAssistantText: "partial",
          assistantTurnProse: "partial",
          outcome: "aborted",
        };
      });

      await runInboundSessionTurn({
        buildTurn: defaultBuildTurn,
        // 100ms coalescing: pushes schedule a timer, so the abort lands while
        // a render is already scheduled (the race the brief calls out).
        streaming: { minIntervalMs: 100, start: streamStart },
        statusBar,
        sliceDisplayText: (t) => t,
        formatAssistantReply: (text) => text,
        formatErrorReply: (err) => String(err),
        sendAssistantBody: vi.fn().mockResolvedValue(undefined),
        sendErrorBody: vi.fn().mockResolvedValue(undefined),
        detachPostTurnDelivery: false,
      });

      // The abort teardown ran: handle finalized, tracker frozen at aborted.
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(finishSpy).toHaveBeenCalledWith("aborted");

      // Deferred-abort post-turn delivery (flush / bar clear / final
      // setFullContent) attempted further ops — all were post-close no-ops.
      expect(handle.state.postCloseAttempts).toBeGreaterThan(0);
      // And NOTHING ever reached the platform after close: the effective
      // edit count is frozen at the abort snapshot despite the late deltas,
      // the deferred-abort delivery, and 10s of leaked-timer time.
      expect(handle.state.closed).toBe(true);
      expect(editsAtAbort).toBeGreaterThan(0);
      expect(handle.state.effectiveEdits).toBe(editsAtAbort);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected final delivery edit terminates cleanly: one attempt, error body sent once, no re-queue", async () => {
    const handle = createFakeStreamHandle();
    const streamStart = vi.fn().mockResolvedValue(handle);
    const sendErrorBody = vi.fn().mockResolvedValue(undefined);

    // The final delivery edit fails transiently (e.g. the target died
    // mid-turn). Delivery must end after that single attempt.
    handle.setFullContent.mockRejectedValueOnce(new Error("ECONNRESET"));

    __setImpl(async () => ({
      latestAssistantText: "done",
      assistantTurnProse: "done",
      outcome: "finished",
    }));

    await runInboundSessionTurn({
      buildTurn: defaultBuildTurn,
      streaming: { minIntervalMs: 0, start: streamStart },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (text) => text,
      formatErrorReply: (err) => `err:${String(err)}`,
      sendAssistantBody: vi.fn().mockResolvedValue(undefined),
      sendErrorBody,
      detachPostTurnDelivery: false,
    });

    // Exactly one delivery attempt — a rejected edit is never retried or
    // re-queued by the turn pipeline.
    expect(handle.setFullContent).toHaveBeenCalledTimes(1);
    // The failure routed to the single error-body path and stopped.
    expect(sendErrorBody).toHaveBeenCalledTimes(1);
    expect(sendBodyMockCalls(sendErrorBody)).toContain("err:Error: ECONNRESET");
  });
});

function sendBodyMockCalls(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}
