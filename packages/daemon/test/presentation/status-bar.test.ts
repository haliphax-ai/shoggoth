import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createTurnStatusBar,
  createStatusBarTurnTracker,
  getStatusBarStats,
} from "../../src/presentation/status-bar";
import type { StatusBarStats } from "../../src/presentation/status-bar";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
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

describe("getStatusBarStats", () => {
  let tmp: string;
  let db: Database.Database;

  function seedStats(
    sessionId: string,
    values: Partial<{
      turn_count: number;
      compaction_count: number;
      input_tokens: number;
      context_window_tokens: number | null;
    }>,
  ): void {
    db.prepare(
      `INSERT INTO session_stats (session_id, turn_count, compaction_count, input_tokens,
              context_window_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      sessionId,
      values.turn_count ?? 0,
      values.compaction_count ?? 0,
      values.input_tokens ?? 0,
      values.context_window_tokens ?? null,
    );
  }

  /** 128_000 chars ≈ 32_000 estimated tokens in the session's current segment. */
  function seedSegmentTranscript(sessionId: string, content: string): void {
    const segmentId = createSessionStore(db).getById(sessionId)!.contextSegmentId;
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content)
       VALUES (?, ?, 0, 'user', ?)`,
    ).run(sessionId, segmentId, content);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sb-stats-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    sessions.create({ id: "s1", workspacePath: tmp });
    sessions.create({ id: "s2", workspacePath: tmp });
    sessions.create({ id: "s3", workspacePath: tmp });
    sessions.create({ id: "s4", workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps session_stats turn_count to sequence and compaction_count to compactions", () => {
    seedStats("s1", { turn_count: 5, compaction_count: 2, input_tokens: 99_999 });
    const stats = getStatusBarStats(db, "s1");
    expect(stats.sequence).toBe(5);
    expect(stats.compactions).toBe(2);
    expect(stats.context).toBeUndefined();
  });

  it("derives context from the segment estimate and the total from context_window_tokens", () => {
    seedStats("s2", {
      turn_count: 7,
      compaction_count: 1,
      input_tokens: 500_000,
      context_window_tokens: 128_000,
    });
    seedSegmentTranscript("s2", "x".repeat(128_000));
    expect(getStatusBarStats(db, "s2").context).toEqual({
      currentTokens: 32_000,
      totalTokens: 128_000,
    });
  });

  it("omits context when the segment estimate is 0", () => {
    seedStats("s3", { turn_count: 3, context_window_tokens: 128_000 });
    const stats = getStatusBarStats(db, "s3");
    expect(stats.sequence).toBe(3);
    expect(stats.context).toBeUndefined();
  });

  it("regression: huge cumulative input_tokens never becomes the current fill", () => {
    // input_tokens is a cumulative running sum across every model call of the
    // segment; a long session can far exceed the window (the ~2000% bug).
    seedStats("s4", {
      turn_count: 9,
      compaction_count: 4,
      input_tokens: 2_000_000,
      context_window_tokens: 1_000_000,
    });
    seedSegmentTranscript("s4", "x".repeat(4_000)); // ≈1_000 estimated tokens
    expect(getStatusBarStats(db, "s4").context).toEqual({
      currentTokens: 1_000,
      totalTokens: 1_000_000,
    });
  });

  it("defaults to zeroed stats for an unknown session", () => {
    expect(getStatusBarStats(db, "missing")).toEqual({ sequence: 0, compactions: 0 });
  });
});

describe("createStatusBarTurnTracker", () => {
  const stats: StatusBarStats = {
    sequence: 7,
    compactions: 2,
    context: { currentTokens: 1_000, totalTokens: 1_000_000 },
  };

  function createTracker(
    overrides: {
      cfg?: ResolvedStatusBarConfig;
      render?: StatusBarRenderer;
      stats?: StatusBarStats;
    } = {},
  ) {
    const render = overrides.render ?? makeRender();
    const tracker = createStatusBarTurnTracker({
      cfg: overrides.cfg ?? defaultCfg,
      render,
      stats: overrides.stats ?? stats,
    });
    const sink = makeSink();
    return { tracker, sink, render };
  }

  it("captures the ⏳ starting line synchronously; attachSink flushes it to the live sink", () => {
    const { tracker, sink } = createTracker();
    // The engine's initial render pre-dates the sink (the old bug: the
    // starting bar never reached the in-flight placeholder). The factory
    // captures it and flushes it the moment a sink attaches.
    tracker.attachSink(sink);
    expect(sink.setStatusBar).toHaveBeenCalledTimes(1);
    expect(sink.setStatusBar.mock.calls[0]![0]).toBe("starting#7");
  });

  it("events drive the snapshot: thinking → tool count → prose → pause → compaction", async () => {
    const lines: string[] = [];
    const render = (snap: StatusBarSnapshot) => {
      const line = `${snap.phase}#t${snap.toolCalls.total}#c${snap.compactions}`;
      lines.push(line);
      return line;
    };
    const { tracker } = createTracker({ render });

    tracker.onThinkingDelta?.("…");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("thinking#t0#c2");

    tracker.onToolCall?.({ phase: "start", name: "builtin-exec", argsJson: "{}" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("tool#t1#c2");

    tracker.onToolCall?.({ phase: "end", name: "builtin-exec", argsJson: "{}", runtimeMs: 5 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("tool#t1#c2");

    tracker.onProse?.("hello");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("prose#t1#c2");

    tracker.onHitlQueued?.({ name: "builtin-exec", argsJson: "{}" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("paused#t1#c2");

    tracker.onCompaction?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.at(-1)).toBe("paused#t1#c3");
  });

  it("finish renders via the injected renderer, returns the line; only the phase differs from live", async () => {
    const { tracker, sink } = createTracker();
    tracker.attachSink(sink);
    const starting = sink.setStatusBar.mock.calls[0]![0] as string;
    tracker.onProse?.("hi");
    await vi.advanceTimersByTimeAsync(1_000);
    const prose = sink.setStatusBar.mock.calls.at(-1)![0] as string;

    const returned = await tracker.finish("finished");
    const terminal = sink.setStatusBar.mock.calls.at(-1)![0] as string;
    expect(returned).toBe(terminal);
    expect(terminal).toBe("finished#7");
    // ONE renderer: the live and terminal lines are the same composition —
    // only the phase (emoji) segment switches with the outcome.
    expect(starting.replace("starting", "phase")).toBe(terminal.replace("finished", "phase"));
    expect(prose.replace("prose", "phase")).toBe(terminal.replace("finished", "phase"));
  });

  it("maps every turn outcome to the matching terminal phase", async () => {
    for (const outcome of ["finished", "aborted", "failed"] as const) {
      const { tracker } = createTracker();
      expect(await tracker.finish(outcome)).toBe(`${outcome}#7`);
    }
  });

  it("returns undefined from finish when every section is disabled (sink saw null)", async () => {
    const { tracker } = createTracker({
      cfg: { ...DEFAULT_STATUS_BAR_CONFIG, enabled: false },
    });
    expect(await tracker.finish("finished")).toBeUndefined();
  });

  it("round-trips getStatusBarStats output for the same session", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "shoggoth-sb-rt-"));
    const db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    try {
      const sessions = createSessionStore(db);
      sessions.create({ id: "rt1", workspacePath: tmp });
      db.prepare(
        `INSERT INTO session_stats (session_id, turn_count, compaction_count, input_tokens,
                context_window_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).run("rt1", 3, 1, 2_000_000, 1_000_000);
      const segmentId = sessions.getById("rt1")!.contextSegmentId;
      db.prepare(
        `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content)
         VALUES (?, ?, 0, 'user', ?)`,
      ).run("rt1", segmentId, "x".repeat(4_000)); // ≈1_000 estimated tokens
      // Same regression shape as the platform e2e test: the snapshot must
      // carry the segment-estimate fill (0.1%/1M), never the cumulative
      // input_tokens column — and it reaches delivery via the tracker's
      // finish() (the ONE terminal composition).
      const render = vi.fn((_snap: StatusBarSnapshot, _cfg: ResolvedStatusBarConfig) => "x");
      const tracker = createStatusBarTurnTracker({
        cfg: defaultCfg,
        render,
        stats: getStatusBarStats(db, "rt1"),
      });
      await tracker.finish("finished");
      const [snap] = render.mock.calls.at(-1)!;
      expect(snap.phase).toBe("finished");
      expect(snap.sequence).toBe(3);
      expect(snap.compactions).toBe(1);
      expect(snap.context).toEqual({ currentTokens: 1_000, totalTokens: 1_000_000 });
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
