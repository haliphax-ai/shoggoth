import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTurnStatusBar } from "../../src/presentation/status-bar";
import type {
  StatusBarSnapshot,
  StatusBarSink,
  StatusBarRenderer,
  TurnStatusBar,
} from "../../src/presentation/status-bar";
import { DEFAULT_STATUS_BAR_CONFIG, type ResolvedStatusBarConfig } from "@shoggoth/shared";

let nowValue = 0;
const now = () => nowValue;

const defaultCfg: ResolvedStatusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG };

function makeRender(): StatusBarRenderer {
  return vi.fn((snap: StatusBarSnapshot, _cfg: ResolvedStatusBarConfig) => {
    return `${snap.phase}#${snap.sequence}`;
  });
}

function makeSink() {
  return {
    setStatusBar: vi.fn().mockResolvedValue(undefined),
  } satisfies StatusBarSink;
}

function createBar(
  opts: {
    sink?: StatusBarSink;
    render?: StatusBarRenderer;
    cfg?: ResolvedStatusBarConfig;
    minIntervalMs?: number;
  } = {},
) {
  const sink = opts.sink ?? makeSink();
  const render = opts.render ?? makeRender();
  const bar = createTurnStatusBar({
    cfg: opts.cfg ?? defaultCfg,
    sink,
    render,
    minIntervalMs: opts.minIntervalMs,
    now,
  });
  return { bar, sink, render };
}

beforeEach(() => {
  vi.useFakeTimers();
  nowValue = 1000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTurnStatusBar", () => {
  it("start() renders the starting phase with sequence and compactions", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 217, compactions: 1 });
    expect(sink.setStatusBar).toHaveBeenCalledTimes(1);
    const snap = sink.setStatusBar.mock.calls[0]![0] as StatusBarSnapshot;
    expect(snap.phase).toBe("starting");
    expect(snap.sequence).toBe(217);
    expect(snap.compactions).toBe(1);
    expect(snap.toolCalls.total).toBe(0);
  });

  it("markThinking transitions phase to thinking", async () => {
    const { bar, sink, render } = createBar();
    await bar.start({ sequence: 1, compactions: 0 });
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "starting" }),
      defaultCfg,
    );
    bar.markThinking();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.setStatusBar).toHaveBeenCalledTimes(2);
    const snap = sink.setStatusBar.mock.calls[1]![0] as StatusBarSnapshot;
    expect(snap.phase).toBe("thinking");
  });

  it("markProse transitions phase to prose", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 2, compactions: 0 });
    bar.markProse();
    await vi.advanceTimersByTimeAsync(1100);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("prose");
  });

  it("toolStarted transitions phase to tool and shows the call", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 3, compactions: 0 });
    bar.toolStarted({ name: "builtin-read", argPreview: "status-bar.ts" });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("tool");
    expect(last.toolCalls.total).toBe(1);
    expect(last.toolCalls.last).toMatchObject({
      name: "builtin-read",
      argPreview: "status-bar.ts",
      running: true,
    });
    expect(last.toolCalls.last!.runtimeMs).toBeUndefined();
  });

  it("markPaused transitions phase to paused and queues the tool uncounted", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 4, compactions: 0 });
    bar.markPaused({ name: "builtin-exec" });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("paused");
    expect(last.toolCalls.total).toBe(0);
    expect(last.toolCalls.last).toEqual({
      name: "builtin-exec",
      argPreview: undefined,
      running: false,
    });
  });

  it("markPaused queues a tool in monospace that is not counted in total", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 5, compactions: 0 });
    bar.toolStarted({ name: "builtin-read" });
    bar.toolFinished();
    bar.toolStarted({ name: "builtin-write" });
    bar.toolFinished();
    bar.markPaused({ name: "builtin-exec" });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.toolCalls.total).toBe(2);
    expect(last.toolCalls.last).toMatchObject({ name: "builtin-exec", running: false });
  });

  it("a subsequent phase event clears the queued paused tool", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 6, compactions: 0 });
    bar.markPaused({ name: "builtin-exec" });
    bar.markThinking();
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("thinking");
    expect(last.toolCalls.last).toBeUndefined();
  });

  it("a terminal event clears the queued paused tool and renders the terminal phase", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 7, compactions: 0 });
    bar.markPaused({ name: "builtin-exec" });
    await bar.finish("failed");
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("failed");
    expect(last.toolCalls.last).toBeUndefined();
  });

  it("toolStarted then toolFinished records runtimeMs via now()", async () => {
    nowValue = 5000;
    const { bar, sink } = createBar();
    await bar.start({ sequence: 8, compactions: 0 });
    nowValue = 5000;
    bar.toolStarted({ name: "builtin-read" });
    nowValue = 7000;
    bar.toolFinished();
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.toolCalls.last).toMatchObject({
      name: "builtin-read",
      running: false,
    });
    expect(last.toolCalls.last!.runtimeMs).toBe(2000);
  });

  it("toolFinished updates the running last call in place and keeps total", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 9, compactions: 0 });
    bar.toolStarted({ name: "builtin-read" });
    bar.toolFinished();
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.toolCalls.total).toBe(1);
    expect(last.toolCalls.last).toMatchObject({ name: "builtin-read", running: false });
  });

  it("a second toolStarted while one is running replaces last but total only bumps once", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 10, compactions: 0 });
    bar.toolStarted({ name: "builtin-read" });
    bar.toolStarted({ name: "builtin-write" });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.toolCalls.total).toBe(1);
    expect(last.toolCalls.last).toMatchObject({ name: "builtin-write", running: true });
  });

  it("updateContext exposes context usage", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 11, compactions: 0 });
    bar.updateContext(12_345, 100_000);
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.context).toEqual({ currentTokens: 12_345, totalTokens: 100_000 });
  });

  it("setCompactions updates the compaction count", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 12, compactions: 0 });
    bar.setCompactions(3);
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.compactions).toBe(3);
  });

  it("finish() renders immediately and then freezes", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 13, compactions: 0 });
    const callsBefore = sink.setStatusBar.mock.calls.length;
    await bar.finish("finished");
    expect(sink.setStatusBar.mock.calls.length).toBe(callsBefore + 1);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.phase).toBe("finished");
  });

  it("markX and toolStarted are no-ops after finish(), and timers are cleared", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 14, compactions: 0 });
    await bar.finish("finished");
    const callsAfterFinish = sink.setStatusBar.mock.calls.length;
    bar.markThinking();
    bar.toolStarted({ name: "builtin-read" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterFinish);
  });

  it("dispose() abandons without a terminal render", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 15, compactions: 0 });
    const callsAfterStart = sink.setStatusBar.mock.calls.length;
    bar.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterStart);
  });

  it("marks dirty and renders only after minIntervalMs elapses (default 1000)", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 16, compactions: 0 });
    const callsAfterStart = sink.setStatusBar.mock.calls.length;
    bar.markProse();
    await vi.advanceTimersByTimeAsync(500);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterStart);
    await vi.advanceTimersByTimeAsync(500);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterStart + 1);
  });

  it("honors a custom minIntervalMs", async () => {
    const { bar, sink } = createBar({ minIntervalMs: 250 });
    await bar.start({ sequence: 17, compactions: 0 });
    const callsAfterStart = sink.setStatusBar.mock.calls.length;
    bar.markProse();
    await vi.advanceTimersByTimeAsync(250);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterStart + 1);
  });

  it("flushes immediately when explicitly requested even inside the interval window", async () => {
    const { bar, sink } = createBar({ minIntervalMs: 5000 });
    await bar.start({ sequence: 18, compactions: 0 });
    const callsAfterStart = sink.setStatusBar.mock.calls.length;
    bar.markProse();
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterStart);
    await bar.finish("finished");
    expect(sink.setStatusBar.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });
});

describe("all-sections-off config", () => {
  it("renders null to the sink when every section is disabled", async () => {
    const allOff: ResolvedStatusBarConfig = {
      enabled: true,
      statusEnabled: false,
      sequenceEnabled: false,
      toolCallsEnabled: false,
      contextWindowEnabled: false,
      compactionsEnabled: false,
    };
    const { bar, sink } = createBar({ cfg: allOff });
    await bar.start({ sequence: 1, compactions: 0 });
    expect(sink.setStatusBar).toHaveBeenCalledWith(null);
  });

  it("renders null on mutations when every section is disabled", async () => {
    const allOff: ResolvedStatusBarConfig = {
      enabled: true,
      statusEnabled: false,
      sequenceEnabled: false,
      toolCallsEnabled: false,
      contextWindowEnabled: false,
      compactionsEnabled: false,
    };
    const { bar, sink } = createBar({ cfg: allOff });
    await bar.start({ sequence: 2, compactions: 0 });
    bar.markThinking();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.setStatusBar).toHaveBeenLastCalledWith(null);
  });
});

describe("TurnStatusBar contract types", () => {
  it("exposes the full surface", async () => {
    const { bar } = createBar();
    const surface: TurnStatusBar = {
      start: bar.start,
      markThinking: bar.markThinking,
      markProse: bar.markProse,
      markPaused: bar.markPaused,
      toolStarted: bar.toolStarted,
      toolFinished: bar.toolFinished,
      updateContext: bar.updateContext,
      setCompactions: bar.setCompactions,
      finish: bar.finish,
      dispose: bar.dispose,
    };
    expect(typeof surface.start).toBe("function");
    expect(typeof surface.markThinking).toBe("function");
    expect(typeof surface.markProse).toBe("function");
    expect(typeof surface.markPaused).toBe("function");
    expect(typeof surface.toolStarted).toBe("function");
    expect(typeof surface.toolFinished).toBe("function");
    expect(typeof surface.updateContext).toBe("function");
    expect(typeof surface.setCompactions).toBe("function");
    expect(typeof surface.finish).toBe("function");
    expect(typeof surface.dispose).toBe("function");
  });
});
