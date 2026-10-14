import type Database from "better-sqlite3";
import type { ResolvedStatusBarConfig } from "@shoggoth/shared";
import { createSessionStore } from "../sessions/session-store";
import { getContextFill } from "../sessions/session-stats-store";
import { getSessionPrimaryModelRef } from "../sessions/model-resolution";
import { getModelContextWindowTokens } from "../model-metadata";
import type { ToolCallEvent } from "../sessions/tool-loop";

export type TurnStatusPhase =
  | "starting"
  | "thinking"
  | "prose"
  | "tool"
  | "paused"
  | "finished"
  | "aborted"
  | "failed";

export interface StatusBarToolCall {
  readonly name: string;
  /** First meaningful argument for builtin tools (e.g. `bash` for `builtin-exec`). */
  readonly argPreview?: string;
}

export interface StatusBarSnapshot {
  readonly phase: TurnStatusPhase;
  readonly sequence: number;
  /** Total executed tool calls this turn; last call details while/after running. */
  readonly toolCalls: {
    readonly total: number;
    readonly last?: {
      readonly name: string;
      readonly argPreview?: string;
      readonly running: boolean;
      readonly runtimeMs?: number;
    };
  };
  /** Absent until first usage data. current = latest per-call input tokens;
   *  totalTokens = the known window, omitted when the window is unknown. */
  readonly context?: { readonly currentTokens: number; readonly totalTokens?: number };
  readonly compactions: number;
  /** Active (non-thread) subagent count for the session, whole descendant tree
   *  included but thread subagent branches pruned. `persistent` counts the
   *  subset spawned with mode "persistent". Absent when never seeded. */
  readonly subagents?: { readonly total: number; readonly persistent: number };
  /** Active (unfired) timer count for the session. Absent when never seeded. */
  readonly timers?: number;
}

/** Platform-supplied sink: applies the rendered bar line to the in-flight message. */
export interface StatusBarSink {
  setStatusBar(line: string | null): Promise<void>;
}

/** Platform-supplied renderer (e.g. Discord blockquote line). */
export type StatusBarRenderer = (snap: StatusBarSnapshot, cfg: ResolvedStatusBarConfig) => string;

export interface TurnStatusBar {
  /** Called once when the turn begins; sets phase ⏳ and performs the first render. */
  start(input: {
    sequence: number;
    context?: { currentTokens: number; totalTokens?: number };
    compactions: number;
    subagents?: { total: number; persistent: number };
    timers?: number;
  }): Promise<void>;
  markThinking(): void; // 🧠
  markProse(): void; // 💬
  /** ⏸️ — HITL approval queued; shows the queued tool until resolved. */
  markPaused(tool: StatusBarToolCall): void;
  toolStarted(call: StatusBarToolCall): void; // ⚡
  toolFinished(): void; // records runtime for the last call
  updateContext(currentTokens: number, totalTokens?: number): void;
  setCompactions(count: number): void;
  /** Live subagent count refresh (spawned/terminated mid-turn). */
  setSubagents(counts: { total: number; persistent: number }): void;
  /** Terminal render (✅/🛑/❌); after this the bar is frozen and timers cleared. */
  finish(outcome: "finished" | "aborted" | "failed"): Promise<void>;
  /** Abandon without a terminal render (e.g. turn dispatch failed before delivery). */
  dispose(): void;
}

export function createTurnStatusBar(opts: {
  cfg: ResolvedStatusBarConfig;
  sink: StatusBarSink;
  render: StatusBarRenderer;
  /** Bar re-render cadence; default 1000 ms. */
  minIntervalMs?: number;
  now?: () => number;
}): TurnStatusBar {
  const cfg = opts.cfg;
  const sink = opts.sink;
  const render = opts.render;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const now = opts.now ?? (() => Date.now());

  const allSectionsOff =
    !cfg.enabled ||
    (!cfg.statusEnabled &&
      !cfg.sequenceEnabled &&
      !cfg.toolCallsEnabled &&
      !cfg.subagentsEnabled &&
      !cfg.timersEnabled &&
      !cfg.contextWindowEnabled &&
      !cfg.compactionsEnabled);

  let finished = false;
  let phase: TurnStatusPhase = "starting";
  let sequence = 0;
  let compactions = 0;
  let context: { currentTokens: number; totalTokens?: number } | undefined;
  let subagents: { total: number; persistent: number } | undefined;
  let timers: number | undefined;
  let totalTools = 0;
  let last:
    | {
        name: string;
        argPreview?: string;
        running: boolean;
        runtimeMs?: number;
      }
    | undefined;
  let startedAt = 0;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function snapshot(): StatusBarSnapshot {
    return {
      phase,
      sequence,
      toolCalls: {
        total: totalTools,
        ...(last ? { last } : {}),
      },
      ...(context ? { context } : {}),
      compactions,
      ...(subagents ? { subagents } : {}),
      ...(timers !== undefined ? { timers } : {}),
    };
  }

  async function doRender() {
    dirty = false;
    const snap = snapshot();
    render(snap, cfg);
    // The sink receives the snapshot (or null when every section is disabled)
    // so the platform can apply/render the bar for the in-flight message.
    await sink.setStatusBar(allSectionsOff ? null : (snap as unknown as string));
  }

  function scheduleRender() {
    if (finished) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (finished || !dirty) return;
      void doRender();
    }, minIntervalMs);
  }

  function clearPausedQueued() {
    if (phase === "paused") {
      last = undefined;
    }
  }

  return {
    async start(input) {
      if (finished) return;
      sequence = input.sequence;
      compactions = input.compactions;
      context = input.context;
      subagents = input.subagents;
      timers = input.timers;
      totalTools = 0;
      last = undefined;
      phase = "starting";
      await doRender();
    },

    markThinking() {
      if (finished) return;
      clearPausedQueued();
      phase = "thinking";
      scheduleRender();
    },

    markProse() {
      if (finished) return;
      clearPausedQueued();
      phase = "prose";
      scheduleRender();
    },

    markPaused(tool) {
      if (finished) return;
      phase = "paused";
      last = { name: tool.name, argPreview: tool.argPreview, running: false };
      scheduleRender();
    },

    toolStarted(call) {
      if (finished) return;
      phase = "tool";
      const inflight = last?.running === true;
      if (!inflight) totalTools += 1;
      last = { name: call.name, argPreview: call.argPreview, running: true };
      startedAt = now();
      scheduleRender();
    },

    toolFinished() {
      if (finished) return;
      if (last?.running) {
        last = {
          ...last,
          running: false,
          runtimeMs: Math.max(0, now() - startedAt),
        };
      }
      scheduleRender();
    },

    updateContext(currentTokens, totalTokens) {
      if (finished) return;
      // Never fake the window from the fill: an unknown total stays unknown
      // (the renderer shows the fill without a percent) until a known window
      // arrives.
      const knownTotal = totalTokens ?? context?.totalTokens;
      context =
        knownTotal !== undefined ? { currentTokens, totalTokens: knownTotal } : { currentTokens };
      scheduleRender();
    },

    setCompactions(count) {
      if (finished) return;
      compactions = count;
      scheduleRender();
    },

    setSubagents(counts) {
      if (finished) return;
      subagents = counts;
      scheduleRender();
    },

    async finish(outcome) {
      if (finished) return;
      finished = true;
      clearPausedQueued();
      phase = outcome;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await doRender();
    },

    dispose() {
      finished = true;
      dirty = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** Pre-turn stats for the turn status bar: sequence (session_stats.turn_count),
 *  compactions (compaction_count), and current context-window fill from the
 *  provider-reported gauge (`session_stats.context_fill_tokens`), falling back
 *  to a transcript heuristic for the session's current context segment.
 *  `session_stats.input_tokens` is a cumulative running sum across every model
 *  call and must NEVER be treated as current context-window fill. */
export interface StatusBarStats {
  readonly sequence: number;
  readonly compactions: number;
  readonly context?: { readonly currentTokens: number; readonly totalTokens?: number };
  /** Active (non-thread) subagent count for the session (whole descendant
   *  tree, thread subagent branches pruned); `persistent` counts the subset
   *  spawned with mode "persistent". */
  readonly subagents?: { readonly total: number; readonly persistent: number };
  /** Active (unfired) timer count for the session (the `timers` table rows
   *  with fired = 0 — the same state the builtin timer-list reads). */
  readonly timers?: number;
}

/** `<10K` → plain integer with thousands separators; `≥10K` → one-decimal K; `≥1M` → one-decimal M. */
export function formatTokens(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) return trimTrailingZero((value / 1_000).toFixed(1)) + "K";
  return trimTrailingZero((value / 1_000_000).toFixed(1)) + "M";
}

function trimTrailingZero(formatted: string): string {
  return formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted;
}

/** Context window for the session's selected model (`providerId/modelName`)
 *  from model metadata (config / provider-reported / known defaults), or 0
 *  when the model or its window is unknown. */
function getModelMetadataContextWindow(modelSelection: unknown): number {
  const modelRef = getSessionPrimaryModelRef(modelSelection);
  if (!modelRef) return 0;
  const slashIdx = modelRef.indexOf("/");
  if (slashIdx <= 0) return 0;
  return (
    getModelContextWindowTokens(modelRef.slice(0, slashIdx), modelRef.slice(slashIdx + 1)) ?? 0
  );
}

/** Sequence from session_stats.turn_count, compactions from compaction_count,
 *  context fill from the provider-reported gauge (last call's total
 *  input+output in session_stats.context_fill_tokens), falling back to the
 *  current context segment's transcript heuristic when the provider has not
 *  reported usage (session_stats.input_tokens is a cumulative running sum and
 *  must never be treated as current context-window fill). `context` is omitted
 *  when the fill is 0; `totalTokens` comes from the session's known context
 *  window (session_stats.context_window_tokens, then model metadata for the
 *  session's selected model) and is omitted when neither is known — never
 *  faked from the fill, which the renderer would display as a bogus 100%. */
export function getStatusBarStats(db: Database.Database, sessionId: string): StatusBarStats {
  const row = db
    .prepare(
      `SELECT turn_count, compaction_count, context_window_tokens
       FROM session_stats WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        turn_count: number;
        compaction_count: number;
        context_window_tokens: number | null;
      }
    | undefined;
  const sessionRow = createSessionStore(db).getById(sessionId);
  const segmentId = sessionRow?.contextSegmentId;
  const currentTokens =
    segmentId !== undefined && segmentId.length > 0 ? getContextFill(db, sessionId, segmentId) : 0;
  const sequence = row?.turn_count ?? 0;
  const compactions = row?.compaction_count ?? 0;
  const subagents = getSessionSubagentCounts(db, sessionId);
  const timers = getSessionActiveTimerCount(db, sessionId);
  if (currentTokens <= 0) return { sequence, compactions, subagents, timers };
  // Known context window: the session_stats gauge first, then model metadata
  // for the session's selected model; unknown (omitted) when neither knows.
  let windowTokens = row?.context_window_tokens ?? 0;
  if (windowTokens <= 0) windowTokens = getModelMetadataContextWindow(sessionRow?.modelSelection);
  return {
    sequence,
    compactions,
    subagents,
    timers,
    context: windowTokens > 0 ? { currentTokens, totalTokens: windowTokens } : { currentTokens },
  };
}

/** Active (non-terminated) subagents belonging to `sessionId`, counting the entire
 *  descendant tree but pruning at thread subagents: a thread-bound subagent and its
 *  whole subtree are excluded from both the total and the persistent count.
 *  `persistent` counts the included subagents spawned with mode "persistent". */
export function getSessionSubagentCounts(
  db: Database.Database,
  sessionId: string,
): { total: number; persistent: number } {
  const store = createSessionStore(db);
  let total = 0;
  let persistent = 0;
  const walk = (parentId: string): void => {
    for (const child of store.list({ parentSessionId: parentId })) {
      if (child.status === "terminated") continue;
      // Thread-bound subagent: excluded along with its entire subtree.
      if (child.subagentPlatformThreadId) continue;
      total += 1;
      if (child.subagentMode === "persistent") persistent += 1;
      walk(child.id);
    }
  };
  walk(sessionId);
  return { total, persistent };
}

/** Active (unfired) timer count for the session — the same state the builtin
 *  timer-list action reads (`timers` rows with fired = 0). */
export function getSessionActiveTimerCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM timers WHERE session_id = ? AND fired = 0")
    .get(sessionId) as { cnt: number };
  return row.cnt;
}

/** One tracker per turn: the live bar and the terminal bar are the same
 *  tracker's snapshots rendered by the same injected renderer — the only
 *  difference between live and terminal is the phase (emoji). The engine
 *  (createTurnStatusBar) renders into an internal capture sink; the captured
 *  line is forwarded to the attached platform sink while the turn runs and
 *  returned from finish() for terminal delivery. There is NO second
 *  composition path. */
export interface TurnStatusBarTracker {
  /** Engine sink entry: renders the snapshot and forwards the line to the
   *  attached sink (captured until one attaches). */
  setStatusBar(line: string | null): Promise<void>;
  /** Wire the live target AND flush the currently captured line to it
   *  immediately (the initial ⏳ render may predate the sink existing). */
  attachSink(sink: StatusBarSink): void;
  /** Terminal render (✅/🛑/❌) via the injected renderer; returns the
   *  rendered line for final delivery (the ONE terminal composition). */
  finish(outcome: "finished" | "aborted" | "failed"): Promise<string | undefined>;
  /** Abandon without a terminal render. */
  dispose(): void;
  /** Assistant prose is streaming from the model (💬). */
  onProse?: (accumulated: string) => void;
  /** Reasoning/thinking content is streaming from the model (🧠). */
  onThinkingDelta?: (accumulated: string) => void;
  /** A tool call started/ended (⚡ + tool-call count). */
  onToolCall?: (ev: ToolCallEvent) => void;
  /** A HITL approval row was queued for a tool call (⏸️). */
  onHitlQueued?: (call: { name: string; argsJson: string }) => void;
  /** A subagent spawn succeeded mid-turn: fresh counts for the section. */
  onSubagentsChanged?: (counts: { readonly total: number; readonly persistent: number }) => void;
  /** A mid-turn compaction completed. */
  onCompaction?: () => void;
  /** A model call reported provider usage: currentTokens is that call's
   *  input tokens (the best mid-turn gauge of context-window fill);
   *  totalTokens is the known/reported window, when available. */
  onContextUpdate?: (update: { currentTokens: number; totalTokens?: number }) => void;
}

/** Factory wiring the engine turn status bar to a capture-then-forward sink.
 *  Starts immediately from the pre-turn stats (the initial ⏳ render is
 *  captured synchronously, so a sink attached afterwards still receives it). */
export function createStatusBarTurnTracker(opts: {
  cfg: ResolvedStatusBarConfig;
  render: StatusBarRenderer;
  stats: StatusBarStats;
  minIntervalMs?: number;
}): TurnStatusBarTracker {
  let liveSink: StatusBarSink | undefined;
  let capturedLine: string | undefined;
  let compactions = opts.stats.compactions;

  // Engine sink: render the platform line for every snapshot, remember it as
  // the current line (capture until a live sink attaches), and forward.
  const captureSink: StatusBarSink = {
    setStatusBar: async (line) => {
      if (line === null) {
        capturedLine = undefined;
        await liveSink?.setStatusBar(null);
        return;
      }
      capturedLine = opts.render(line as unknown as StatusBarSnapshot, opts.cfg);
      await liveSink?.setStatusBar(capturedLine);
    },
  };

  const engine = createTurnStatusBar({
    cfg: opts.cfg,
    sink: captureSink,
    render: opts.render,
    ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
  });

  void engine.start({
    sequence: opts.stats.sequence,
    compactions: opts.stats.compactions,
    ...(opts.stats.context ? { context: opts.stats.context } : {}),
    ...(opts.stats.subagents ? { subagents: opts.stats.subagents } : {}),
    ...(opts.stats.timers !== undefined ? { timers: opts.stats.timers } : {}),
  });

  return {
    setStatusBar: (line) => captureSink.setStatusBar(line),
    attachSink(sink) {
      liveSink = sink;
      // Flush the captured (⏳ starting) line so the in-flight placeholder
      // carries the bar even though the initial render predated the sink.
      if (capturedLine !== undefined) void sink.setStatusBar(capturedLine);
    },
    async finish(outcome) {
      await engine.finish(outcome);
      return capturedLine;
    },
    dispose() {
      engine.dispose();
      liveSink = undefined;
    },
    onProse: () => engine.markProse(),
    onThinkingDelta: () => engine.markThinking(),
    onToolCall: (ev) => {
      if (ev.phase === "start") engine.toolStarted({ name: ev.name });
      else engine.toolFinished();
    },
    onHitlQueued: (call) => engine.markPaused({ name: call.name }),
    onSubagentsChanged: (counts) => engine.setSubagents(counts),
    onCompaction: () => engine.setCompactions(++compactions),
    onContextUpdate: (update) => engine.updateContext(update.currentTokens, update.totalTokens),
  };
}
