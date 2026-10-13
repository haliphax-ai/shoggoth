import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createTurnStatusBar,
  createStatusBarTurnTracker,
  getStatusBarStats,
  getSessionSubagentCounts,
  getSessionActiveTimerCount,
} from "../../src/presentation/status-bar";
import type { StatusBarStats } from "../../src/presentation/status-bar";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { setModelMetadataFromProvider } from "../../src/model-metadata";
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

  it("updateContext with an unknown window never fakes the total from the fill", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 15, compactions: 0 });
    bar.updateContext(22_500);
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    // The fill must not masquerade as the window (`total = fill` rendered as
    // a bogus 100%); an unknown window stays absent until one is known.
    expect(last.context).toEqual({ currentTokens: 22_500 });
  });

  it("setCompactions updates the compaction count", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 12, compactions: 0 });
    bar.setCompactions(3);
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.compactions).toBe(3);
  });

  it("setSubagents updates the subagent counts mid-turn", async () => {
    const { bar, sink } = createBar();
    await bar.start({
      sequence: 21,
      compactions: 0,
      subagents: { total: 0, persistent: 0 },
    });
    bar.setSubagents({ total: 2, persistent: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.subagents).toEqual({ total: 2, persistent: 1 });
  });

  it("setSubagents seeds the section when it was never seeded at start", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 22, compactions: 0 });
    bar.setSubagents({ total: 1, persistent: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const last = sink.setStatusBar.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(last.subagents).toEqual({ total: 1, persistent: 1 });
  });

  it("setSubagents is a no-op after finish()", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 23, compactions: 0, subagents: { total: 1, persistent: 0 } });
    await bar.finish("finished");
    const callsAfterFinish = sink.setStatusBar.mock.calls.length;
    bar.setSubagents({ total: 5, persistent: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.setStatusBar.mock.calls.length).toBe(callsAfterFinish);
  });

  it("carries the seeded timer count into the snapshot", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 19, compactions: 0, timers: 2 });
    const snap = sink.setStatusBar.mock.calls[0]![0] as StatusBarSnapshot;
    expect(snap.timers).toBe(2);
  });

  it("omits timers from the snapshot when never seeded", async () => {
    const { bar, sink } = createBar();
    await bar.start({ sequence: 20, compactions: 0 });
    const snap = sink.setStatusBar.mock.calls[0]![0] as StatusBarSnapshot;
    expect(snap.timers).toBeUndefined();
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
      subagentsEnabled: false,
      timersEnabled: false,
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
      subagentsEnabled: false,
      timersEnabled: false,
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
      setSubagents: bar.setSubagents,
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
    expect(typeof surface.setSubagents).toBe("function");
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

  /** Create a subagent session bound to `parent` with the given mode/thread/status. */
  function seedSubagent(
    id: string,
    parent: string,
    opts: { mode?: "one_shot" | "persistent"; threadId?: string | null; status?: string } = {},
  ): void {
    const sessions = createSessionStore(db);
    sessions.create({ id, workspacePath: tmp });
    sessions.update(id, {
      parentSessionId: parent,
      ...(opts.mode ? { subagentMode: opts.mode } : {}),
      ...(opts.threadId !== undefined ? { subagentPlatformThreadId: opts.threadId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    });
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

  it("prefers the provider-reported context-fill gauge over the segment estimate", () => {
    seedStats("s3", { turn_count: 4, context_window_tokens: 128_000 });
    seedSegmentTranscript("s3", "x".repeat(128_000)); // ≈32_000 estimated tokens
    db.prepare("UPDATE session_stats SET context_fill_tokens = 41000 WHERE session_id = ?").run(
      "s3",
    );
    expect(getStatusBarStats(db, "s3").context).toEqual({
      currentTokens: 41_000,
      totalTokens: 128_000,
    });
  });

  it("falls back to model metadata for the window when session_stats has none", () => {
    // The session's selected model has a known window in model metadata
    // (config / provider-reported / known defaults) even though the provider
    // never reported one into session_stats.
    setModelMetadataFromProvider("sbmeta-pro", "sbmeta-model", 128_000);
    createSessionStore(db).create({
      id: "s5",
      workspacePath: tmp,
      modelSelection: { model: "sbmeta-pro/sbmeta-model" },
    });
    seedStats("s5", { turn_count: 2 });
    seedSegmentTranscript("s5", "x".repeat(4_000)); // ≈1_000 estimated tokens
    expect(getStatusBarStats(db, "s5").context).toEqual({
      currentTokens: 1_000,
      totalTokens: 128_000,
    });
  });

  it("omits the window (never faked from the fill) when no context window is known", () => {
    createSessionStore(db).create({
      id: "s6",
      workspacePath: tmp,
      modelSelection: { model: "unknown-pro/unknown-model" },
    });
    seedStats("s6", { turn_count: 2 });
    seedSegmentTranscript("s6", "x".repeat(4_000)); // ≈1_000 estimated tokens
    // Without a known window the snapshot carries the fill only — the
    // renderer drops the percent instead of dividing the fill by itself.
    expect(getStatusBarStats(db, "s6").context).toEqual({ currentTokens: 1_000 });
  });

  it("defaults to zeroed stats for an unknown session", () => {
    expect(getStatusBarStats(db, "missing")).toEqual({
      sequence: 0,
      compactions: 0,
      subagents: { total: 0, persistent: 0 },
      timers: 0,
    });
  });

  it("includes the active (non-thread) subagent counts", () => {
    createSessionStore(db).create({ id: "p1", workspacePath: tmp });
    seedSubagent("p1-bg", "p1", { mode: "one_shot" });
    seedSubagent("p1-thr", "p1", { mode: "persistent", threadId: "thread-1" });
    expect(getStatusBarStats(db, "p1").subagents).toEqual({ total: 1, persistent: 0 });
  });

  it("includes the active (unfired) timer count for the session", () => {
    createSessionStore(db).create({ id: "t1", workspacePath: tmp });
    const insert = db.prepare(
      "INSERT INTO timers (id, session_id, label, fire_at, message, fired) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("tm-a", "t1", "a", "2030-01-01T00:00:00Z", "a", 0);
    insert.run("tm-b", "t1", "b", "2030-01-01T00:00:00Z", "b", 0);
    insert.run("tm-c", "t1", "c", "2030-01-01T00:00:00Z", "c", 1); // fired: not counted
    expect(getStatusBarStats(db, "t1").timers).toBe(2);
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

  it("onContextUpdate feeds provider-reported fill into the live bar mid-turn (first turn)", async () => {
    // First-turn seed shape: no pre-turn context (empty transcript, no
    // provider gauge yet). The first usage delta is what makes the context
    // section appear — it must reach the live sink on the next render.
    const render = vi.fn((snap: StatusBarSnapshot) => `${snap.phase}#${snap.sequence}`);
    const { tracker, sink } = createTracker({ render, stats: { sequence: 1, compactions: 0 } });
    tracker.attachSink(sink);
    const startingSnap = render.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(startingSnap.context).toBeUndefined();

    tracker.onContextUpdate?.({ currentTokens: 31_400, totalTokens: 200_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const lastSnap = render.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(lastSnap.context).toEqual({ currentTokens: 31_400, totalTokens: 200_000 });
    expect(sink.setStatusBar).toHaveBeenLastCalledWith("starting#1");
  });

  it("an onContextUpdate without totalTokens keeps the seeded window", async () => {
    const render = vi.fn((snap: StatusBarSnapshot) => `${snap.phase}#${snap.sequence}`);
    const { tracker } = createTracker({ render });
    tracker.onContextUpdate?.({ currentTokens: 31_400 });
    await vi.advanceTimersByTimeAsync(1_000);
    const lastSnap = render.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(lastSnap.context).toEqual({ currentTokens: 31_400, totalTokens: 1_000_000 });
  });

  it("onSubagentsChanged feeds a mid-turn spawn into the live bar", async () => {
    // The subagent was spawned AFTER the bar was seeded from pre-turn stats,
    // so the fresh counts must reach the live snapshot during the same turn —
    // not wait for the next turn's pre-turn stats.
    const render = vi.fn((snap: StatusBarSnapshot) => `${snap.phase}#${snap.sequence}`);
    const { tracker, sink } = createTracker({
      render,
      stats: { sequence: 1, compactions: 0, subagents: { total: 0, persistent: 0 } },
    });
    tracker.attachSink(sink);
    const startingSnap = render.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(startingSnap.subagents).toEqual({ total: 0, persistent: 0 });

    tracker.onSubagentsChanged?.({ total: 2, persistent: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    const lastSnap = render.mock.calls.at(-1)![0] as StatusBarSnapshot;
    expect(lastSnap.subagents).toEqual({ total: 2, persistent: 1 });
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
        "INSERT INTO timers (id, session_id, label, fire_at, message) VALUES (?, ?, ?, ?, ?)",
      ).run("rt-timer", "rt1", "check-in", "2030-01-01T00:00:00Z", "check-in");
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
      expect(snap.timers).toBe(1);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("getSessionSubagentCounts", () => {
  let tmp: string;
  let db: Database.Database;

  function seedSubagent(
    id: string,
    parent: string,
    opts: { mode?: "one_shot" | "persistent"; threadId?: string | null; status?: string } = {},
  ): void {
    const sessions = createSessionStore(db);
    sessions.create({ id, workspacePath: tmp });
    sessions.update(id, {
      parentSessionId: parent,
      ...(opts.mode ? { subagentMode: opts.mode } : {}),
      ...(opts.threadId !== undefined ? { subagentPlatformThreadId: opts.threadId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sb-sub-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "root", workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns zero counts for a session with no subagents (or a missing session)", () => {
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 0, persistent: 0 });
    expect(getSessionSubagentCounts(db, "missing")).toEqual({ total: 0, persistent: 0 });
  });

  it("counts the entire descendant tree of background subagents", () => {
    seedSubagent("a", "root", { mode: "one_shot" });
    seedSubagent("b", "root", { mode: "one_shot" });
    seedSubagent("a1", "a", { mode: "one_shot" });
    seedSubagent("a1x", "a1", { mode: "one_shot" });
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 4, persistent: 0 });
  });

  it("counts persistent background subagents in the persistent total", () => {
    seedSubagent("p", "root", { mode: "persistent" });
    seedSubagent("o", "root", { mode: "one_shot" });
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 2, persistent: 1 });
  });

  it("excludes terminated subagents", () => {
    seedSubagent("live", "root", { mode: "one_shot" });
    seedSubagent("dead", "root", { mode: "one_shot", status: "terminated" });
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 1, persistent: 0 });
  });

  it("prunes thread subagent branches (thread subagent and its whole subtree)", () => {
    seedSubagent("bg", "root", { mode: "one_shot" });
    seedSubagent("thr", "root", { mode: "persistent", threadId: "thread-1" });
    seedSubagent("thr-child", "thr", { mode: "one_shot" });
    seedSubagent("thr-child2", "thr-child", { mode: "persistent" });
    // Only the direct background subagent counts; the whole thread subtree is
    // pruned (matching the issue example: 1 of 7 displayed).
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 1, persistent: 0 });
  });

  it("a persistent background subagent's own background children still count", () => {
    seedSubagent("pp", "root", { mode: "persistent" });
    seedSubagent("pp-child", "pp", { mode: "one_shot" });
    expect(getSessionSubagentCounts(db, "root")).toEqual({ total: 2, persistent: 1 });
  });
});

describe("getSessionActiveTimerCount", () => {
  let tmp: string;
  let db: Database.Database;

  function seedTimer(id: string, sessionId: string, fired = 0): void {
    db.prepare(
      "INSERT INTO timers (id, session_id, label, fire_at, message, fired) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, sessionId, id, "2030-01-01T00:00:00Z", id, fired);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-sb-timers-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "root", workspacePath: tmp });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 0 for a session with no timers (or a missing session)", () => {
    expect(getSessionActiveTimerCount(db, "root")).toBe(0);
    expect(getSessionActiveTimerCount(db, "missing")).toBe(0);
  });

  it("counts only unfired timers for the session", () => {
    seedTimer("t1", "root", 0);
    seedTimer("t2", "root", 0);
    seedTimer("t3", "root", 1);
    expect(getSessionActiveTimerCount(db, "root")).toBe(2);
  });

  it("does not count other sessions' timers", () => {
    createSessionStore(db).create({ id: "other", workspacePath: tmp });
    seedTimer("t1", "other", 0);
    expect(getSessionActiveTimerCount(db, "root")).toBe(0);
  });
});
