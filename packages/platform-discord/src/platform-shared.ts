/**
 * Shared internals for platform-discord turn surfaces: HITL queued-notice
 * delivery, stream-handle plumbing, terminal-outcome mapping, and status-bar
 * dep shapes. Consumed by platform.ts and the per-surface extractions so a
 * shared behavior fix cannot miss one copy; not part of the public API
 * (platform.ts re-exports `buildStatusBarDep` for compatibility).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createOutboundMessage } from "@shoggoth/messaging";
import {
  getStatusBarStats,
  type SessionAgentTurnResult,
  type StatusBarSnapshot,
  type StreamHandle,
} from "@shoggoth/daemon/lib";
import type { ResolvedStatusBarConfig } from "@shoggoth/shared";
import type { DiscordMessagingRuntime } from "./bridge";
import type { Logger, PendingActionRow } from "./daemon-types";
import { sliceDiscordPlatformMessageBody } from "./errors";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { buildHitlQueuedNoticeLines } from "./hitl/notifier";
import { registerDiscordHitlNoticeAndAddReactions } from "./hitl/reaction-wiring";
import { renderDiscordStatusBar } from "./status-bar";
import type { DiscordStreamHandle } from "./streaming";

/** Where/how an in-session HITL queued notice is delivered. */
export interface HitlQueuedDelivery {
  readonly sessionId: string;
  readonly userId?: string;
  readonly replyToMessageId?: string;
}

// ── Terminal outcome mapping ─────────────────────────────────────────────────

/** Narrow a turn outcome to the status bar's terminal set: everything but
 *  "completed" passes through; "completed" renders as "finished". Shared by the
 *  messaging_surface and internal delivery paths so the mapping cannot drift. */
export function terminalOutcomeOf(
  outcome: SessionAgentTurnResult["outcome"],
): "finished" | "aborted" | "failed" | "canceled" {
  return outcome === "aborted" || outcome === "failed" || outcome === "canceled"
    ? outcome
    : "finished";
}

// ── Stream-handle plumbing ───────────────────────────────────────────────────

/** Status-bar dep as consumed by the stream-handle start helper: the config
 *  flag and the attach sink, without the render/stats surface. */
export interface StreamStatusBarDep {
  readonly config: ResolvedStatusBarConfig;
  readonly attachSink: (h: StreamHandle) => unknown;
}

/** Wiring for `startStreamHandleWithBar`: logging, env flags, the status-bar
 *  dep, and the session's streaming outbound resolver. */
export interface StartStreamHandleWithBarDeps {
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly statusBarDep: StreamStatusBarDep;
  readonly streamingForSession: DiscordMessagingRuntime["streamingForSession"];
}

/** Build the status-bar-wrapped stream handle over a raw Discord stream handle:
 *  setFullContent/pushUpdate delegate straight through, setStatusBar/close pass
 *  through when the raw handle supports them. Shared by the inbound pre-start
 *  path and the messaging_surface path so a teardown fix cannot miss one copy. */
export function wrapDiscordStreamHandle(raw: DiscordStreamHandle): StreamHandle {
  return {
    setFullContent: (text: string) => raw.setFullContent(text),
    pushUpdate: (text: string) => raw.pushUpdate(text),
    ...(raw.setStatusBar ? { setStatusBar: (line: string | null) => raw.setStatusBar!(line) } : {}),
    // Teardown pass-through: the abort path must be able to
    // finalize the underlying handle through this wrapper.
    ...(raw.close ? { close: () => raw.close!() } : {}),
  };
}

/** Start the session's streaming outbound and wrap the raw handle with the
 *  status-bar sink so the bar applies to the in-flight message (delegates to
 *  any native setStatusBar on the handle; teardown close() passes through).
 *  Returns undefined when streaming is disabled, the session has no streaming
 *  outbound, or the start failed (logged as `stream_start_failed` — pass
 *  `warn.withSessionId` to include the session id in that payload, matching
 *  the messaging_surface path's original shape). Shared by the inbound
 *  pre-start path and the messaging_surface path so a teardown fix cannot
 *  miss one copy. */
export async function startStreamHandleWithBar(
  deps: StartStreamHandleWithBarDeps,
  sessionId: string,
  warn?: { readonly withSessionId?: boolean },
): Promise<StreamHandle | undefined> {
  let handle: StreamHandle | undefined;
  if (deps.env.SHOGGOTH_DISCORD_STREAM === "1") {
    const streamingOutbound = deps.streamingForSession(sessionId);
    if (streamingOutbound) {
      try {
        const raw = await streamingOutbound.start();
        // Wrap the raw stream handle with the status-bar sink so the bar
        // applies to the in-flight message; delegates to any native
        // setStatusBar on the handle.
        if (deps.statusBarDep.config.enabled) {
          deps.statusBarDep.attachSink(raw as unknown as StreamHandle);
        }
        handle = wrapDiscordStreamHandle(raw);
      } catch (e) {
        deps.logger.warn(
          "discord.platform.stream_start_failed",
          warn?.withSessionId ? { err: String(e), sessionId } : { err: String(e) },
        );
      }
    }
  }
  return handle;
}

// ── HITL queued-notice delivery ──────────────────────────────────────────────

/** Send the in-session HITL queued notice and wire up approval reactions.
 *  Closure-free: the Discord runtime, notice registry, and logger are passed
 *  in explicitly so every turn surface can deliver through the same path. */
export async function sendHitlQueuedNotice(
  deps: {
    readonly discord: Pick<DiscordMessagingRuntime, "outbound" | "discordRestTransport">;
    readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
    readonly logger: Logger;
  },
  row: PendingActionRow,
  delivery: HitlQueuedDelivery,
): Promise<void> {
  const ref = await deps.discord.outbound.sendDiscord(
    createOutboundMessage({
      id: randomUUID(),
      sessionId: delivery.sessionId,
      userId: delivery.userId,
      createdAt: new Date().toISOString(),
      body: sliceDiscordPlatformMessageBody(buildHitlQueuedNoticeLines(row).join("\n")),
      extensions: { replyToMessageId: delivery.replyToMessageId },
    }),
  );
  if (deps.hitlDiscordNoticeRegistry) {
    await registerDiscordHitlNoticeAndAddReactions({
      transport: deps.discord.discordRestTransport,
      channelId: ref.channelId,
      messageId: ref.messageId,
      row,
      registry: deps.hitlDiscordNoticeRegistry,
      logger: deps.logger,
    });
  }
}

/** Build the `afterHitlQueued` callback that posts the in-session HITL queued
 *  notice; undefined when SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0. Shared by
 *  the inbound, messaging_surface, and internal delivery paths. */
export function afterHitlQueuedFor(
  env: NodeJS.ProcessEnv,
  send: (row: PendingActionRow, delivery: HitlQueuedDelivery) => Promise<void>,
  delivery: HitlQueuedDelivery,
): ((row: PendingActionRow) => Promise<void>) | undefined {
  const inSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";
  return inSession ? (row) => send(row, delivery) : undefined;
}

// ── Status-bar dependency shapes ─────────────────────────────────────────────

/** Pre-turn stats seed for the status bar (sequence / compactions / context
 *  window fill / live activity counts) — sourced daemon-side; the platform
 *  only wires them in. */
export interface DiscordStatusBarDepStats {
  sequence: number;
  compactions: number;
  context?: { currentTokens: number; totalTokens?: number };
  subagents?: { total: number; persistent: number };
  timers?: number;
  notifies?: number;
  liveNotifies?: () => number;
  liveTimers?: () => number;
  liveSubagents?: () => { total: number; persistent: number };
}

/** The platform's status-bar dependency as passed to the presentation
 *  orchestrator and turn surfaces: config + renderer + live-bar sink + stats
 *  seeding + live activity providers. */
export interface DiscordPlatformStatusBarDep {
  config: ResolvedStatusBarConfig;
  render: (snap: StatusBarSnapshot, c: ResolvedStatusBarConfig) => string;
  attachSink: (h: StreamHandle) => { setStatusBar(line: string | null): Promise<void> };
  stats: (sessionId: string) => DiscordStatusBarDepStats;
  cruiseControlActive?: (sessionId: string) => boolean;
  yoloModeActive?: (sessionId: string) => boolean;
}

/** Minimal status-bar dep: config from resolveStatusBarConfig, render from renderDiscordStatusBar,
 *  attachSink for live-bar stream wrapping, and stats seeded from session_stats (turn.db is
 *  unavailable when the orchestrator creates the tracker); passed to the presentation orchestrator. */
export function buildStatusBarDep(
  db: Database.Database,
  cfg: ResolvedStatusBarConfig,
  cruiseControlActive?: (sessionId: string) => boolean,
  yoloModeActive?: (sessionId: string) => boolean,
): DiscordPlatformStatusBarDep {
  return {
    config: cfg,
    render: renderDiscordStatusBar,
    // Wrap the stream handle in place: the sink delegates to any native
    // setStatusBar (Discord streaming applies the bar to the in-flight message)
    // and the augmented handle is returned so streaming keeps working through it.
    attachSink: (h: StreamHandle) => {
      const native = h.setStatusBar?.bind(h);
      const sink = {
        setStatusBar: async (line: string | null) => {
          await native?.(line);
        },
      };
      h.setStatusBar = (line: string | null) => sink.setStatusBar(line);
      return h as StreamHandle & typeof sink;
    },
    // Pre-turn stats for seeding the bar (sequence / compactions / context
    // window fill) — sourced daemon-side; the platform only wires them in.
    stats: (sessionId: string) => getStatusBarStats(db, sessionId),
    // Live activity providers — invalidate-on-change: the engine re-reads
    // each only when its source's change version moves (zero DB reads on
    // steady-state renders).
    ...(cruiseControlActive ? { cruiseControlActive } : {}),
    ...(yoloModeActive ? { yoloModeActive } : {}),
  };
}
