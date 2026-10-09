import type { ResolvedStatusBarConfig } from "@shoggoth/shared";

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
  /** Absent until first usage data. current = latest per-call input tokens. */
  readonly context?: { readonly currentTokens: number; readonly totalTokens: number };
  readonly compactions: number;
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
    context?: { currentTokens: number; totalTokens: number };
    compactions: number;
  }): Promise<void>;
  markThinking(): void; // 🧠
  markProse(): void; // 💬
  /** ⏸️ — HITL approval queued; shows the queued tool until resolved. */
  markPaused(tool: StatusBarToolCall): void;
  toolStarted(call: StatusBarToolCall): void; // ⚡
  toolFinished(): void; // records runtime for the last call
  updateContext(currentTokens: number, totalTokens?: number): void;
  setCompactions(count: number): void;
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
      !cfg.contextWindowEnabled &&
      !cfg.compactionsEnabled);

  let finished = false;
  let phase: TurnStatusPhase = "starting";
  let sequence = 0;
  let compactions = 0;
  let context: { currentTokens: number; totalTokens: number } | undefined;
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
      if (totalTokens !== undefined || context === undefined) {
        context = {
          currentTokens,
          totalTokens: totalTokens ?? context?.totalTokens ?? currentTokens,
        };
      } else {
        context = { ...context, currentTokens };
      }
      scheduleRender();
    },

    setCompactions(count) {
      if (finished) return;
      compactions = count;
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
