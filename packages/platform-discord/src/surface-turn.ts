/**
 * Surface turn engine: one session model turn as presented on a turn surface.
 * Covers the `messaging_surface` delivery branch (live streamed edits, in-turn
 * banner splicing, terminal composition) and the internal delivery path (used
 * by subagent/tool turns and the OOB banner surface). Extracted from
 * platform.ts behind an explicit deps + per-turn state parameter: the ~10
 * per-turn mutable bindings live on {@link SurfaceTurnState} instead of
 * platform-closure capture, so the abort path tears down exactly the state of
 * its own turn.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelInvocationParams } from "@shoggoth/models";
import type { HitlAutoApproveGate, ShoggothConfig, SystemContext } from "@shoggoth/shared";
import {
  createCoalescingStreamPusher,
  createStatusBarTurnTracker,
  createThinkingOutput,
  createTurnBannerCollector,
  executeSessionAgentTurn,
  formatAssistantReply,
  invalidateStatusBarSources,
  normalizeRoundProse,
  registerActiveTurnSurface,
  renderTurnTerminationBody,
  resolveSessionBypassUpTo,
  type ExecuteSessionAgentTurnInput,
  type PendingActionsStore,
  type PlatformAssistantDeps,
  type PolicyEngine,
  type RunToolLoopHitl,
  type SessionAgentTurnResult,
  type SessionModelTurnDelivery,
  type SessionRow,
  type SessionStore,
  type StreamHandle,
  type TieredTurnQueue,
  type ToolRunStore,
  type TranscriptStore,
  type TurnBannerCollector,
  type TurnStatusBarTracker,
} from "@shoggoth/daemon/lib";
import type { DiscordMessagingRuntime } from "./bridge";
import { resolveDiscordOwnerUserId } from "./config";
import type { HitlNotifier, Logger, PendingActionRow } from "./daemon-types";
import type { DiscordPlatformAdapter } from "./discord-platform-adapter";
import {
  afterHitlQueuedFor,
  startStreamHandleWithBar,
  terminalOutcomeOf,
  type DiscordPlatformStatusBarDep,
  type HitlQueuedDelivery,
} from "./platform-shared";

/** Input for one surface turn (the platform handle's turn shape). */
export interface SurfaceTurnInput {
  readonly sessionId: string;
  readonly userContent: string;
  readonly userMetadata?: Record<string, unknown>;
  readonly systemContext?: SystemContext;
  readonly delivery: SessionModelTurnDelivery;
  readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
  /** Operator-facing banner spliced into this turn's output before the model's prose. */
  readonly turnBanner?: string;
  readonly statusBarSink?: { setStatusBar: (line: string | null) => Promise<void> };
}

/** The messaging_surface delivery variant, narrowed for the delivery branch. */
type MessagingSurfaceDelivery = Extract<SessionModelTurnDelivery, { kind: "messaging_surface" }>;

/**
 * Mutable per-turn surface state — the ~10 bindings previously captured by
 * platform closures (tracker, thinking composer, streaming pipeline, banner
 * collector, live display, committed-prose anchors). Created per turn and
 * passed explicitly through the engine, including the abort path, so nothing
 * outside the engine owns this turn's presentation state.
 */
export interface SurfaceTurnState {
  /** Live + terminal status bar for this turn (messaging_surface and
   *  caller-provided `statusBarSink` paths). */
  surfaceTracker: TurnStatusBarTracker | undefined;
  thinkingOutput: ReturnType<typeof createThinkingOutput> | undefined;
  surfaceStreamPusher: ReturnType<typeof createCoalescingStreamPusher> | undefined;
  /** Declared at state scope (not inside the messaging_surface branch) so the
   *  abort handler can finalize the in-flight message handle. */
  surfaceStreamHandle: StreamHandle | undefined;
  /** Round-settled prose of earlier rounds for the live display when the
   *  thinking composer is disabled (showThinking === false surfaces still
   *  show every round, separated by the transcript's blank line). */
  surfacePriorRoundsProse: string;
  /** In-turn banner anchors: the runner's live position (committed prose
   *  segments / tool calls) captured at notice-fire time. */
  surfaceCommittedProseSegments: number;
  surfaceToolCalls: number;
  /** The turn's committed prose segments, pushed in lockstep with
   *  `surfaceCommittedProseSegments` (same admission condition): a round still
   *  streaming is not committed, so mid-round notices ride the tail append. */
  readonly surfaceCommittedProse: string[];
  surfaceDisplay: string;
  /** Every push re-renders display + notices from scratch (the coalescing
   *  pusher ships the latest state), so banners land chronologically, never
   *  patched into a pushed message. */
  readonly surfaceBanners: TurnBannerCollector;
}

/**
 * Build the per-turn surface state. A caller-provided banner (e.g. a steer
 * banner) anchors at slot 0 — before the model's first prose segment — so the
 * output attributes the turn to its prompt. Added before any turn output
 * exists; live display and terminal body both carry it.
 */
export function createSurfaceTurnState(turnBanner?: string): SurfaceTurnState {
  // The banner collector's closures dereference `st` lazily (at notice-fire
  // time), so the two-phase init below is safe.
  const st: SurfaceTurnState = {
    surfaceTracker: undefined,
    thinkingOutput: undefined,
    surfaceStreamPusher: undefined,
    surfaceStreamHandle: undefined,
    surfacePriorRoundsProse: "",
    surfaceCommittedProseSegments: 0,
    surfaceToolCalls: 0,
    surfaceCommittedProse: [],
    surfaceDisplay: "",
    // Assigned immediately below; the collector only reads the struct at
    // notice-fire time, after construction completes.
    surfaceBanners: null as unknown as TurnBannerCollector,
  };
  (st as { surfaceBanners: TurnBannerCollector }).surfaceBanners = createTurnBannerCollector({
    captureAnchor: () => ({
      committedProseSegments: st.surfaceCommittedProseSegments,
      toolCalls: st.surfaceToolCalls,
    }),
    onNotice: () => {
      if (st.surfaceStreamPusher) pushSurfaceDisplay(st, st.surfaceDisplay || "…");
    },
  });
  if (turnBanner) st.surfaceBanners.add(turnBanner);
  return st;
}

/** Wiring for the surface turn engine: the platform's stores, HITL stack,
 *  policy configuration, status-bar dep, and Discord delivery surface. The
 *  engine captures nothing from the platform scope — everything arrives here. */
export interface SurfaceTurnDeps {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly configRef?: { readonly current: ShoggothConfig };
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly sessions: SessionStore;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly turnQueue: TieredTurnQueue;
  readonly resolveMcpContext: ExecuteSessionAgentTurnInput["resolveMcpContext"];
  readonly policyEngine: PolicyEngine;
  readonly getHitlConfig: () => ShoggothConfig["hitl"];
  readonly pendingForToolLoop: PendingActionsStore;
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
  readonly hitlNotifier: HitlNotifier;
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
  readonly loopImpl: PlatformAssistantDeps["runToolLoopImpl"];
  readonly createToolCallingClient: PlatformAssistantDeps["createToolCallingClient"];
  /** Spread into a turn's `hitl` object to enable cruise control for the loop. */
  readonly cruiseControlToolLoopHook: () => Partial<Pick<RunToolLoopHitl, "cruiseControl">>;
  readonly yoloActive: (sessionId: string) => boolean;
  /** Live cruise-control activity provider for status-bar trackers (undefined: none). */
  readonly cruiseControlActiveFor: ((sessionId: string) => boolean) | undefined;
  /** Live yolo-mode activity provider for status-bar trackers. */
  readonly yoloModeActive: (sessionId: string) => boolean;
  readonly adapter: DiscordPlatformAdapter;
  readonly streamingForSession: DiscordMessagingRuntime["streamingForSession"];
  readonly statusBarDep: DiscordPlatformStatusBarDep;
  /** In-session HITL queued-notice sender (wired to the Discord runtime). */
  readonly hitlQueuedNotice: (row: PendingActionRow, delivery: HitlQueuedDelivery) => Promise<void>;
  /** The config the Discord owner gate resolves against. */
  readonly configForOwnerGate: () => ShoggothConfig;
  readonly resolveOutboundChannelIdForSession?: (sessionId: string) => string | undefined;
  /** Minimum interval between coalesced stream edits (env-derived). */
  readonly streamMinMs: () => number;
}

/** Per-turn engine context: the state struct plus the turn's resolved inputs. */
interface SurfaceTurnContext {
  readonly st: SurfaceTurnState;
  readonly input: SurfaceTurnInput;
  readonly sid: string;
  readonly sessionRow: SessionRow;
  readonly userMetadata: Record<string, unknown>;
  readonly buildAfterHitlQueued: (delivery: {
    readonly userId: string;
    readonly replyToMessageId?: string;
  }) => ((row: PendingActionRow) => Promise<void>) | undefined;
}

/** The per-turn executeTurn closure: runs the session agent turn wired to the
 *  surface's events/stream. */
type SurfaceTurnExecutor = (
  afterHitlQueued?: (row: PendingActionRow) => void | Promise<void>,
  streamOverride?: ExecuteSessionAgentTurnInput["stream"],
) => Promise<SessionAgentTurnResult>;

/** Live-display text with the streaming placeholder for blank output. */
const displayOrPlaceholder = (display: string): string => (display.trim() ? display : "…");

/** Append the rendered terminal status-bar line, when one exists. */
const withBarLine = (body: string, barLine: string | undefined): string =>
  barLine ? `${body}\n\n${barLine}` : body;

/** The live config: the platform's mutable config reference when provided. */
function surfaceTurnConfig(deps: SurfaceTurnDeps): ShoggothConfig {
  return deps.configRef?.current ?? deps.config;
}

/** Push the live display through the coalescing pusher, re-spliced with the
 *  turn's banners. */
function pushSurfaceDisplay(st: SurfaceTurnState, display: string): void {
  st.surfaceDisplay = display;
  if (!st.surfaceStreamPusher) return;
  st.surfaceStreamPusher.push(
    st.surfaceBanners.liveBody(display, { segments: st.surfaceCommittedProse }),
  );
}

/** Create the turn's status-bar tracker with the platform's live activity
 *  providers. Shared by the messaging_surface and internal delivery paths so
 *  the tracker wiring cannot drift. */
function createSurfaceTracker(deps: SurfaceTurnDeps, sid: string): TurnStatusBarTracker {
  const cruiseControlActiveFor = deps.cruiseControlActiveFor;
  return createStatusBarTurnTracker({
    cfg: deps.statusBarDep.config,
    render: deps.statusBarDep.render,
    stats: deps.statusBarDep.stats(sid),
    ...(cruiseControlActiveFor ? { cruiseControlActive: () => cruiseControlActiveFor(sid) } : {}),
    yoloModeActive: () => deps.yoloModeActive(sid),
  });
}

/** Forward a tracker event (HITL pause / compaction / context fill): the
 *  tracker method when the tracker exists. Also used by the count-change
 *  handlers below so the live bar re-renders mid-turn without waiting for
 *  the version poll. */
function forwardToTracker(
  st: SurfaceTurnState,
  method: keyof TurnStatusBarTracker,
  ...args: unknown[]
): void {
  const tracker = st.surfaceTracker;
  const fn = tracker?.[method] as ((...a: unknown[]) => void) | undefined;
  fn?.(...args);
}

/** Turn events forwarding the surface state into the tracker so the live bar
 *  re-renders mid-turn (thinking / tool count / HITL pause / compaction /
 *  context fill). `onTurnAborted` stops the pusher and freezes the tracker
 *  even on a hung call. */
function surfaceTurnEvents(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
): NonNullable<ExecuteSessionAgentTurnInput["events"]> {
  const st = ctx.st;
  return {
    onThinkingDelta: (ev: { accumulated: string; round: number }) => {
      if (st.thinkingOutput) {
        const display = st.thinkingOutput.onThinking(ev);
        if (st.surfaceStreamPusher) pushSurfaceDisplay(st, displayOrPlaceholder(display));
      }
      st.surfaceTracker?.onThinkingDelta?.(ev.accumulated);
    },
    onToolCall: (ev) => {
      st.surfaceToolCalls += 1;
      st.surfaceTracker?.onToolCall?.(ev);
    },
    onHitlQueued: (call) => forwardToTracker(st, "onHitlQueued", call),
    onCompactionStart: () => forwardToTracker(st, "onCompactionStart"),
    onCompaction: () => forwardToTracker(st, "onCompaction"),
    onCompactionFailed: () => forwardToTracker(st, "onCompactionFailed"),
    onContextUpdate: (update) => forwardToTracker(st, "onContextUpdate", update),
    // Count-change events: keep the 🕵️/⏰/↩️ sections live on this
    // path — bumps re-arm the version poll; tracker pushes keep
    // the cache fresh without waiting for it.
    onSubagentsChanged: (counts) => {
      invalidateStatusBarSources("subagents");
      forwardToTracker(st, "onSubagentsChanged", counts);
    },
    onTimersChanged: (count) => {
      invalidateStatusBarSources("timers");
      forwardToTracker(st, "onTimersChanged", count);
    },
    onNotifiesChanged: (count) => {
      invalidateStatusBarSources("notifies");
      forwardToTracker(st, "onNotifiesChanged", count);
    },
    // Abort while the model call may still stream or hang: stop the
    // producers immediately — post-turn delivery never runs for a
    // promise that never settles. finish("aborted") freezes the 🛑 render.
    onTurnAborted: () => {
      st.surfaceStreamPusher?.stop();
      // Deterministic teardown: no producer (late deltas, stray
      // renders) may edit the aborted turn's message after this point.
      st.surfaceStreamHandle?.close?.();
      if (st.surfaceTracker) {
        void st.surfaceTracker.finish("aborted").catch((e) => {
          deps.logger.warn("discord.platform.status_bar_abort_finish_failed", {
            sessionId: ctx.sid,
            err: String(e),
          });
        });
      }
    },
  };
}

/** Run the session agent turn wired to this surface's events/stream and the
 *  platform's HITL stack. Shared by both delivery paths so the wiring cannot
 *  drift. */
function executeSurfaceTurn(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  afterHitlQueued?: (row: PendingActionRow) => void | Promise<void>,
  streamOverride?: ExecuteSessionAgentTurnInput["stream"],
): Promise<SessionAgentTurnResult> {
  const st = ctx.st;
  return executeSessionAgentTurn({
    db: deps.db,
    sessionId: ctx.sid,
    session: ctx.sessionRow,
    transcript: deps.transcript,
    toolRuns: deps.toolRuns,
    userContent: ctx.input.userContent,
    userMetadata: ctx.userMetadata,
    systemContext: ctx.input.systemContext,
    modelInvocationOverride: ctx.input.modelInvocationOverride,

    env: deps.env,
    config: deps.config,
    policyEngine: deps.policyEngine,
    getHitlConfig: deps.getHitlConfig,
    hitl: {
      bypassUpTo: resolveSessionBypassUpTo(ctx.sid, deps.config),
      yoloActive: deps.yoloActive,
      pending: deps.pendingForToolLoop,
      clock: { nowMs: () => Date.now() },
      newPendingId: () => randomUUID(),
      waitForHitlResolution: deps.waitForHitlResolution,
      hitlNotifier: deps.hitlNotifier,
      autoApprove: deps.hitlAutoApproveGate,
      ...deps.cruiseControlToolLoopHook(),
      ...(afterHitlQueued ? { afterHitlQueued } : {}),
    },
    loopImpl: deps.loopImpl,
    createToolCallingClient: deps.createToolCallingClient,
    resolveMcpContext: deps.resolveMcpContext,
    ...(streamOverride ? { stream: streamOverride } : {}),
    ...(st.surfaceTracker || st.thinkingOutput || st.surfaceStreamPusher
      ? { events: surfaceTurnEvents(deps, ctx) }
      : {}),
  });
}

/** The messaging_surface stream argument: per-round prose/thinking display
 *  handlers when the coalescing pusher exists, a bare stream otherwise. */
function messagingSurfaceStreamArg(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
): ExecuteSessionAgentTurnInput["stream"] {
  const st = ctx.st;
  if (!st.surfaceStreamPusher) {
    return deps.env.SHOGGOTH_DISCORD_STREAM === "1" || st.thinkingOutput
      ? { streamModel: true }
      : undefined;
  }
  return {
    streamModel: true,
    onModelTextDelta: (ev: { accumulated: string; round: number }) => {
      const display = st.thinkingOutput
        ? st.thinkingOutput.onText(ev)
        : st.surfacePriorRoundsProse + ev.accumulated;
      pushSurfaceDisplay(st, displayOrPlaceholder(display));
      // Prose phase (💬) on the live bar.
      st.surfaceTracker?.onProse?.(ev.accumulated);
    },
    onModelRoundEnd: (ev: { round: number; content: string }) => {
      // A settled round commits one prose segment when its normalized
      // content is non-blank — same condition as the inbound path, so
      // anchors map 1:1; whitespace-only content never enters.
      const prose = normalizeRoundProse(ev.content);
      if (prose) {
        st.surfaceCommittedProseSegments += 1;
        st.surfaceCommittedProse.push(prose);
      }
      let display: string;
      if (st.thinkingOutput) {
        display = st.thinkingOutput.endRound(ev);
      } else {
        // The committed list and `surfacePriorRoundsProse`
        // track the same segments; rebuild the display from
        // it so the two can never drift.
        st.surfacePriorRoundsProse = st.surfaceCommittedProse.join("\n\n");
        display = st.surfacePriorRoundsProse;
      }
      pushSurfaceDisplay(st, displayOrPlaceholder(display));
    },
  };
}

/** Set up the messaging_surface presentation pipeline before the turn runs:
 *  status-bar tracker, thinking composer, stream handle, and coalescing
 *  pusher — all recorded on the per-turn state struct. */
async function beginMessagingSurface(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
): Promise<void> {
  const st = ctx.st;

  // Snapshot stats BEFORE the turn runs: executing the turn increments
  // session_stats.turn_count, and the bar must report the sequence of
  // the very turn it belongs to (not the next one).
  if (deps.statusBarDep.config.enabled) {
    st.surfaceTracker = createSurfaceTracker(deps, ctx.sid);
  }

  // With streaming, post the placeholder ("…") BEFORE the typing indicator
  // (Discord cancels typing when a bot posts), then coalesce text deltas into
  // live edits of that message, matching the inbound-turn pathway.
  st.thinkingOutput =
    surfaceTurnConfig(deps).platforms?.showThinking === false ? undefined : createThinkingOutput();
  st.surfaceStreamHandle = await startStreamHandleWithBar(
    {
      logger: deps.logger,
      env: deps.env,
      statusBarDep: deps.statusBarDep,
      streamingForSession: deps.streamingForSession,
    },
    ctx.sid,
    { withSessionId: true },
  );
  // Wire the tracker's live target; the tracker flushes its
  // captured ⏳ line so the placeholder carries the bar from turn
  // start (capture-fallback until this handle exists).
  st.surfaceTracker?.attachSink({
    setStatusBar: (line: string | null) =>
      st.surfaceStreamHandle?.setStatusBar
        ? st.surfaceStreamHandle.setStatusBar(line)
        : Promise.resolve(),
  });
  st.surfaceStreamPusher = st.surfaceStreamHandle
    ? createCoalescingStreamPusher((s) => st.surfaceStreamHandle!.pushUpdate(s), deps.streamMinMs())
    : undefined;
}

/** Clear the in-flight handle's active-bar state (a state-only operation that
 *  makes no edit) so the terminal delivery edit, whose body already carries
 *  barLine, lands the bar exactly once. Never blocks delivery. */
async function clearInFlightBar(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  barLine: string | undefined,
): Promise<void> {
  const handle = ctx.st.surfaceStreamHandle;
  if (barLine && handle?.setStatusBar) {
    try {
      await handle.setStatusBar(null);
    } catch (e) {
      deps.logger.warn("discord.platform.status_bar_clear_failed", {
        sessionId: ctx.sid,
        err: String(e),
      });
    }
  }
}

/** One terminal-composition input: the pre-shaped base body, the prose
 *  segments banners splice against, the rendered terminal bar line, and the
 *  turn result (for the failure notice). */
interface TerminalComposition {
  readonly turnResult: SessionAgentTurnResult;
  readonly terminationBase: string;
  readonly terminationSegments: string[];
  readonly barLine: string | undefined;
}

/** ONE terminal render: compose the shaped body — banners spliced at their
 *  anchors, the failure notice appended last (so it can never fall into an
 *  unresolvable-anchor fallback slot ahead of in-turn banners), the terminal
 *  bar line appended last of all. Returns undefined only on the streamed
 *  fail-open path (no terminal edit). */
async function composeSurfaceFullBody(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  comp: TerminalComposition,
): Promise<string | undefined> {
  const st = ctx.st;
  const { turnResult, terminationBase, terminationSegments, barLine } = comp;
  const failed = turnResult.outcome === "failed";
  try {
    const shaped = await renderTurnTerminationBody(terminationBase, [
      (body: string) => st.surfaceBanners.terminalBody(body, { segments: terminationSegments }),
    ]);
    const withNotice =
      failed && turnResult.failureNotice
        ? shaped
          ? `${shaped}\n\n${turnResult.failureNotice}`
          : turnResult.failureNotice
        : shaped;
    return withBarLine(withNotice, barLine);
  } catch (e) {
    deps.logger.warn("discord.platform.termination_shaping_failed", {
      sessionId: ctx.sid,
      err: String(e),
    });
    if (st.surfaceStreamPusher && st.surfaceStreamHandle) {
      // Streamed path fails open: no terminal edit — the streamed output
      // stands, and the failure notice is lost here rather than risking a
      // wrong body (the bar still carries the ❌ outcome).
      return undefined;
    }
    // Non-streamed path has nothing streamed to fall back on — deliver
    // unshaped, exactly once, with the bar the tracker rendered (and the
    // failure notice when the turn failed, rather than dropping it).
    const unshaped =
      failed && turnResult.failureNotice && terminationBase
        ? `${terminationBase}\n\n${turnResult.failureNotice}`
        : terminationBase;
    return withBarLine(unshaped, barLine);
  }
}

/** The ONE terminal render delivery: exactly one edit/send carries the final
 *  shaped body. Streamed turns edit the in-flight message (attachments go as
 *  a follow-up body — stream edits can't carry them); non-streamed turns send
 *  the body as a reply. */
async function deliverSurfaceTerminalBody(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  fullBody: string,
  turnResult: SessionAgentTurnResult,
  replyToMessageId: string | undefined,
): Promise<void> {
  const st = ctx.st;
  if (st.surfaceStreamPusher && st.surfaceStreamHandle) {
    await st.surfaceStreamHandle.setFullContent(fullBody);
    // Stream edits can't carry file attachments — send as follow-up.
    const attachments = turnResult.showAttachments;
    if (attachments?.length) {
      await deps.adapter.sendBody(ctx.sid, "", { attachments: [...attachments] });
    }
    return;
  }
  await deps.adapter.sendBody(ctx.sid, fullBody, { replyTo: replyToMessageId });
}

/** Compose the turn's terminal body and deliver it: tracker finish (frozen
 *  bar), final streamed edit, termination shaping, then the one delivery
 *  edit/send. Returns the turn result unchanged. */
async function composeAndDeliverSurfaceTerminal(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  turnResult: SessionAgentTurnResult,
  replyToMessageId: string | undefined,
): Promise<SessionAgentTurnResult> {
  const st = ctx.st;
  const cfg = surfaceTurnConfig(deps);
  // Compose the body from the turn's full prose (every assistant text
  // segment, in order) so multi-segment turns deliver ALL segments; a
  // FAILED turn delivers the streamed snapshot + failureNotice instead.
  const failed = turnResult.outcome === "failed";
  const snapshot = st.surfaceDisplay.trim() && st.surfaceDisplay !== "…" ? st.surfaceDisplay : "";
  const replyText = turnResult.assistantTurnProse ?? turnResult.latestAssistantText;
  // ONE terminal composition: tracker finish() renders the frozen bar
  // (✅/🛑/❌) through the same renderer as the live bar; the terminal
  // snapshot carries this turn's real tool-call count.
  const barLine = st.surfaceTracker
    ? await st.surfaceTracker.finish(terminalOutcomeOf(turnResult.outcome))
    : undefined;
  if (st.surfaceStreamPusher && st.surfaceStreamHandle) {
    // Final streamed edit first — it renders only the live display re-spliced
    // with banners (never the terminal composition), so the in-flight message
    // never shows banners smashed to the bottom mid-termination.
    await st.surfaceStreamPusher.flush();
    await clearInFlightBar(deps, ctx, barLine);
  }
  // Termination shaping runs ONE final body through ONE terminal render —
  // no intermediate layout can exist. Fail-open per path: the streamed
  // path makes no edit; the non-streamed path still delivers unshaped.
  const formattedBody = formatAssistantReply(
    cfg,
    ctx.sid,
    deps.env,
    replyText,
    turnResult.failoverMeta,
  );
  // Failed: the display snapshot IS the body (already carries live
  // decoration); normal: format the reply and let the composer wrap it.
  // Splice segments are cut from the same source either way.
  const terminationBase = failed
    ? snapshot || turnResult.assistantTurnProse || ""
    : (st.thinkingOutput?.render(formattedBody) ?? formattedBody);
  const terminationSegments = (failed ? terminationBase : replyText).split("\n\n");
  const fullBody = await composeSurfaceFullBody(deps, ctx, {
    turnResult,
    terminationBase,
    terminationSegments,
    barLine,
  });
  // Streamed fail-open: the streamed output stands, no terminal edit.
  if (fullBody === undefined) return turnResult;
  await deliverSurfaceTerminalBody(deps, ctx, fullBody, turnResult, replyToMessageId);
  return turnResult;
}

/** The `messaging_surface` delivery branch: live streamed edits of the
 *  in-flight message, in-turn banner splicing, and the terminal composition
 *  delivered at turn end. */
async function deliverOnMessagingSurface(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  delivery: MessagingSurfaceDelivery,
  executeTurn: SurfaceTurnExecutor,
): Promise<SessionAgentTurnResult> {
  const st = ctx.st;
  await beginMessagingSurface(deps, ctx);

  // In-turn surface notices: register the state's banner collector so
  // mid-turn banners fold into this turn's output instead of standalone
  // messages; every live push already renders through it.
  const surfaceUnregister = registerActiveTurnSurface(ctx.sid, st.surfaceBanners).unregister;

  let turnResult!: SessionAgentTurnResult;
  try {
    await deps.adapter.withTypingIndicator(ctx.sid, async () => {
      turnResult = await executeTurn(
        ctx.buildAfterHitlQueued(delivery),
        messagingSurfaceStreamArg(deps, ctx),
      );
      turnResult = await composeAndDeliverSurfaceTerminal(
        deps,
        ctx,
        turnResult,
        delivery.replyToMessageId,
      );
    });
    return turnResult;
  } finally {
    surfaceUnregister();
  }
}

/** The `internal` delivery path: parent-session HITL notice wiring, an OOB
 *  banner status-bar sink tracker when the caller provided one, and the
 *  terminal bar line attached to the turn result for the banner's final edit. */
async function runInternalDelivery(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  executeTurn: SurfaceTurnExecutor,
): Promise<SessionAgentTurnResult> {
  const st = ctx.st;
  const sid = ctx.sid;
  let internalAfterHitlQueued: ((row: PendingActionRow) => void | Promise<void>) | undefined;
  if (
    ctx.sessionRow.parentSessionId &&
    afterHitlQueuedFor(deps.env, deps.hitlQueuedNotice, { sessionId: sid })
  ) {
    const parentRow = deps.sessions.getById(ctx.sessionRow.parentSessionId);
    const parentChannelId = parentRow
      ? deps.resolveOutboundChannelIdForSession?.(parentRow.id)
      : undefined;
    if (parentChannelId) {
      const ownerUserId = resolveDiscordOwnerUserId(deps.configForOwnerGate());
      internalAfterHitlQueued = afterHitlQueuedFor(deps.env, deps.hitlQueuedNotice, {
        sessionId: ctx.sessionRow.parentSessionId!,
        userId: ownerUserId ?? "system",
      });
    }
  }

  // OOB banner surface: with a caller-provided status-bar sink, create the
  // same tracker as messaging_surface turns so the live bar streams into the
  // banner message. Stats snapshotted BEFORE the turn.
  if (ctx.input.statusBarSink && deps.statusBarDep.config.enabled) {
    st.surfaceTracker = createSurfaceTracker(deps, sid);
    st.surfaceTracker.attachSink(ctx.input.statusBarSink);
  }

  deps.logger.debug("platform.executeTurn_calling", {
    sessionId: sid,
    delivery: ctx.input.delivery.kind,
  });
  const internalStreamModel = surfaceTurnConfig(deps).agents?.internalStreaming !== false;
  let turnResult = await executeTurn(internalAfterHitlQueued, {
    streamModel: internalStreamModel,
  });
  return finishInternalTrackerBar(deps, ctx, turnResult);
}

/** Freeze the internal path's bar at its terminal render (✅/🛑/❌) so the
 *  banner's final edit carries the same terminal bar a normal turn would. The
 *  caller's `oobTurnBanner.finish` clears the sink and edits the body
 *  afterwards; the rendered bar line rides on the turn result. */
async function finishInternalTrackerBar(
  deps: SurfaceTurnDeps,
  ctx: SurfaceTurnContext,
  turnResult: SessionAgentTurnResult,
): Promise<SessionAgentTurnResult> {
  const tracker = ctx.st.surfaceTracker;
  if (!tracker) return turnResult;
  try {
    // Capture the rendered terminal bar line (the ONE terminal
    // composition) and attach it to the turn result so the caller can
    // hand it back to `oobTurnBanner.finish` for the final edit.
    const barLine = await tracker.finish(terminalOutcomeOf(turnResult.outcome));
    return barLine ? { ...turnResult, statusBarLine: barLine } : turnResult;
  } catch (e) {
    deps.logger.warn("discord.platform.oob_status_bar_finish_failed", {
      sessionId: ctx.sid,
      err: String(e),
    });
    return turnResult;
  }
}

/**
 * Run one session model turn on a turn surface. Enqueues behind the session's
 * turn queue, resolves the MCP context, then dispatches to the
 * `messaging_surface` delivery branch or the internal delivery path. Both
 * paths operate on the caller-built {@link SurfaceTurnState}.
 */
export async function runSurfaceTurn(
  deps: SurfaceTurnDeps,
  st: SurfaceTurnState,
  input: SurfaceTurnInput,
): Promise<SessionAgentTurnResult> {
  const sid = input.sessionId.trim();
  const sessionRow = deps.sessions.getById(sid);
  if (!sessionRow || sessionRow.status === "terminated") {
    throw new Error(`session not available: ${sid}`);
  }
  let turnResult!: SessionAgentTurnResult;
  await deps.turnQueue.enqueue(sid, "system", input.systemContext?.kind ?? "system", async () => {
    deps.logger.debug("platform.turn_queue_acquired", { sessionId: sid });
    deps.logger.debug("platform.mcp_context_resolving", { sessionId: sid });
    const mcpCtx = await deps.resolveMcpContext(sid);
    deps.logger.debug("platform.mcp_context_resolved", {
      sessionId: sid,
      toolCount: mcpCtx.toolsLoop.length,
    });
    const ctx: SurfaceTurnContext = {
      st,
      input,
      sid,
      sessionRow,
      userMetadata: input.userMetadata ?? {},
      buildAfterHitlQueued: (delivery) =>
        afterHitlQueuedFor(deps.env, deps.hitlQueuedNotice, {
          sessionId: sid,
          userId: delivery.userId,
          replyToMessageId: delivery.replyToMessageId,
        }),
    };
    const executeTurn: SurfaceTurnExecutor = (afterHitlQueued, streamOverride) =>
      executeSurfaceTurn(deps, ctx, afterHitlQueued, streamOverride);

    if (input.delivery.kind === "messaging_surface") {
      turnResult = await deliverOnMessagingSurface(deps, ctx, input.delivery, executeTurn);
      return;
    }
    turnResult = await runInternalDelivery(deps, ctx, executeTurn);
  });
  return turnResult;
}
