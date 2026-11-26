/**
 * Inbound message state machine and pipeline: per-session chained dispatch,
 * inbound message handling (segment inline commands, owner gate, thread
 * sentinel), and the queued inbound model turn (pre-start stream handle,
 * HITL queued wiring, queued-message indicator). Extracted from platform.ts
 * behind an explicit deps parameter — no platform closure capture; the
 * per-session chain tail lives here so a stop() tears down exactly the
 * chains this pipeline owns.
 */

import { randomUUID } from "node:crypto";
import { getImageBlockCodec } from "@shoggoth/models";
import type Database from "better-sqlite3";
import {
  createOutboundMessage,
  type InternalMessage,
  type MessageAttachment,
} from "@shoggoth/messaging";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
  createQueuedMessageIndicator,
  parseSessionSegmentInlineCommand,
  resolveModel,
  resolveSessionBypassUpTo,
  sessionSegmentStartupUserContent,
  shouldSkipThreadSessionSentinel,
  type PendingActionsStore,
  type PlatformAssistantDeps,
  type PolicyEngine,
  type PresentationTurnOrchestrator,
  type SessionMcpRuntime,
  type SessionRow,
  type SessionStore,
  type TieredTurnQueue,
  type ToolRunStore,
  type TranscriptStore,
} from "@shoggoth/daemon/lib";
import type { DiscordMessagingRuntime } from "./bridge";
import { resolveDiscordOwnerUserId } from "./config";
import type { HitlNotifier, Logger, NoticeResolver, PendingActionRow } from "./daemon-types";
import type { DiscordPlatformAdapter } from "./discord-platform-adapter";
import { sliceDiscordPlatformMessageBody } from "./errors";
import { formatAttachmentMetadata } from "./attachment-metadata";
import { notice } from "./notices";
import {
  afterHitlQueuedFor,
  startStreamHandleWithBar,
  type DiscordPlatformStatusBarDep,
  type HitlQueuedDelivery,
} from "./platform-shared";
import type { RunToolLoopHitl } from "@shoggoth/daemon/lib";

/** Wiring for the inbound turn pipeline: the platform's stores, HITL stack,
 *  MCP runtime, presentation orchestrator, and Discord delivery surface. The
 *  pipeline captures nothing from the platform scope — everything arrives here. */
export interface InboundTurnDeps {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly configRef?: { readonly current: ShoggothConfig };
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly sessions: SessionStore;
  readonly transcript: TranscriptStore;
  readonly toolRuns: ToolRunStore;
  readonly turnQueue: TieredTurnQueue;
  readonly mcpRuntime: SessionMcpRuntime;
  readonly policyEngine: PolicyEngine;
  readonly getHitlConfig: () => ShoggothConfig["hitl"];
  readonly pendingForToolLoop: PendingActionsStore;
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
  readonly hitlNotifier: HitlNotifier;
  readonly hitlAutoApproveGate?: import("@shoggoth/shared").HitlAutoApproveGate;
  readonly loopImpl: PlatformAssistantDeps["runToolLoopImpl"];
  readonly createToolCallingClient: PlatformAssistantDeps["createToolCallingClient"];
  /** Spread into a turn's `hitl` object to enable cruise control for the loop. */
  readonly cruiseControlToolLoopHook: () => Partial<Pick<RunToolLoopHitl, "cruiseControl">>;
  readonly yoloActive: (sessionId: string) => boolean;
  readonly adapter: DiscordPlatformAdapter;
  readonly orchestrator: PresentationTurnOrchestrator;
  readonly statusBarDep: DiscordPlatformStatusBarDep;
  /** In-session HITL queued-notice sender (wired to the Discord runtime). */
  readonly hitlQueuedNotice: (row: PendingActionRow, delivery: HitlQueuedDelivery) => Promise<void>;
  readonly noticeResolver: NoticeResolver;
  readonly discord: DiscordMessagingRuntime;
  /** The config the Discord owner gate resolves against. */
  readonly configForOwnerGate: () => ShoggothConfig;
}

/** The inbound turn pipeline: chained dispatch plus deterministic teardown. */
export interface InboundTurnPipeline {
  /** Run an inbound message after every earlier message for the same session. */
  readonly dispatchChained: (sessionId: string, msg: InternalMessage) => Promise<void>;
  /** Flush every in-flight per-session chain (platform stop path). */
  readonly stop: () => Promise<void>;
}

/** Live config: the platform's mutable config reference when provided. */
function inboundTurnConfig(deps: InboundTurnDeps): ShoggothConfig {
  return deps.configRef?.current ?? deps.config;
}

/** Send a Discord reply quoting the inbound message that caused it. */
async function sendInboundReply(
  deps: InboundTurnDeps,
  msg: InternalMessage,
  body: string,
): Promise<void> {
  await deps.discord.outbound.sendDiscord(
    createOutboundMessage({
      id: randomUUID(),
      sessionId: msg.sessionId,
      userId: msg.userId,
      createdAt: new Date().toISOString(),
      body: sliceDiscordPlatformMessageBody(body),
      extensions: { replyToMessageId: msg.id },
    }),
  );
}

/**
 * Create the inbound turn pipeline. The per-session chain tail map is owned
 * here: `dispatchChained` serializes a session's messages behind one another,
 * and `stop` awaits the in-flight chains after the platform unsubscribes.
 */
export function createInboundTurnPipeline(deps: InboundTurnDeps): InboundTurnPipeline {
  const chainTail = new Map<string, Promise<void>>();

  async function dispatchChained(sessionId: string, msg: InternalMessage): Promise<void> {
    const prev = chainTail.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => handleInbound(msg));
    chainTail.set(
      sessionId,
      run.catch(() => {}),
    );
    await run;
  }

  async function handleInbound(msg: InternalMessage): Promise<void> {
    if (msg.direction !== "inbound") return;
    const text = msg.body?.trim() ?? "";
    if (!text) return;

    const session = deps.sessions.getById(msg.sessionId);
    if (!session) {
      deps.logger.warn("discord.platform.no_session", {
        sessionId: msg.sessionId,
        hint: "no SQLite session row for this route; the daemon auto-bootstraps the main agent session on startup — check config and restart",
      });
      return;
    }

    const ownerSnowflake = resolveDiscordOwnerUserId(deps.configForOwnerGate());
    if (ownerSnowflake && !session.subagentMode) {
      if (!msg.extensions.platform?.discord?.isOwner) return;
    }

    const segmentMode = parseSessionSegmentInlineCommand(text);
    if (segmentMode) {
      try {
        if (segmentMode === "new") {
          applySessionContextSegmentNew({
            db: deps.db,
            sessions: deps.sessions,
            pending: deps.pendingForToolLoop,
            sessionId: msg.sessionId,
          });
        } else {
          applySessionContextSegmentReset({
            db: deps.db,
            sessions: deps.sessions,
            pending: deps.pendingForToolLoop,
            sessionId: msg.sessionId,
          });
        }
      } catch (e) {
        deps.logger.warn("discord.platform.segment_command_failed", {
          err: String(e),
          sessionId: msg.sessionId,
          mode: segmentMode,
        });
        try {
          await sendInboundReply(
            deps,
            msg,
            notice(deps.noticeResolver, "segment-command-error", {
              mode: segmentMode,
              error: String(e),
            }),
          );
        } catch {
          /* ignore */
        }
        return;
      }
      const sessionAfter = deps.sessions.getById(msg.sessionId);
      if (!sessionAfter) return;
      const segShort = sessionAfter.contextSegmentId.slice(0, 8);
      const ack =
        segmentMode === "new"
          ? notice(deps.noticeResolver, "segment-ack-new", { segmentPreview: segShort })
          : notice(deps.noticeResolver, "segment-ack-reset", { segmentPreview: segShort });
      try {
        await sendInboundReply(deps, msg, ack);
      } catch (e) {
        deps.logger.warn("discord.platform.segment_ack_failed", {
          err: String(e),
        });
      }
      await runDiscordInboundModelTurn(
        msg,
        sessionAfter,
        sessionSegmentStartupUserContent(segmentMode),
        {
          sessionSegmentStartup: segmentMode,
        },
      );
      return;
    }

    const userContent = msg.body;
    const attachments = msg.extensions.attachments;

    await runDiscordInboundModelTurn(msg, session, userContent, {}, attachments);
  }

  async function runDiscordInboundModelTurn(
    msg: InternalMessage,
    session: SessionRow,
    userContent: string,
    extraUserMetadata: Record<string, unknown>,
    attachments?: readonly MessageAttachment[],
  ): Promise<void> {
    // Thread sentinel: a thread subagent's first "." message only starts the thread
    // (status already posted at create time) — exit before placeholder/typing/queue
    // side effects; attachments keep the body non-"." so they behave normally.
    if (
      !attachments?.length &&
      shouldSkipThreadSessionSentinel({
        db: deps.db,
        sessions: deps.sessions,
        sessionId: msg.sessionId,
        body: userContent,
      })
    ) {
      deps.logger.debug("discord.platform.thread_sentinel_skipped", {
        sessionId: msg.sessionId,
        messageId: msg.id,
      });
      return;
    }

    // Queued-message indicator (issue #399): ⏳ reaction while the operator's message
    // waits behind an in-flight turn (reply/post fallback without reactions); removed
    // when the turn starts or the entry is dropped.
    const queuedIndicator = createQueuedMessageIndicator({
      sessionId: msg.sessionId,
      messageId: msg.id,
      capabilities: deps.adapter.capabilities,
      logger: deps.logger,
      resolveChannelId: (sid) => deps.discord.resolveOutboundChannelIdForSession?.(sid),
      sendReply: async (body) => {
        await sendInboundReply(deps, msg, body);
      },
      sendPost: async (body) => {
        await deps.discord.outbound.sendDiscord(
          createOutboundMessage({
            id: randomUUID(),
            sessionId: msg.sessionId,
            userId: msg.userId,
            createdAt: new Date().toISOString(),
            body: sliceDiscordPlatformMessageBody(body),
            extensions: {},
          }),
        );
      },
    });

    // Fire-and-forget: push to the turn queue (synchronous) and return immediately.
    // Create a label with truncated message content for display in queue
    const maxLabelLength = 100;
    const userMessageLabel =
      userContent.length > maxLabelLength
        ? userContent.slice(0, maxLabelLength) + "..."
        : userContent;

    void deps.turnQueue
      .enqueue(
        msg.sessionId,
        "user",
        userMessageLabel,
        async () => {
          const afterHitlQueued = afterHitlQueuedFor(deps.env, deps.hitlQueuedNotice, {
            sessionId: msg.sessionId,
            userId: msg.userId,
            replyToMessageId: msg.id,
          });

          const mcpLifecycle = deps.mcpRuntime.trackInstanceIdle
            ? {
                onTurnBegin: () => {
                  deps.mcpRuntime.notifyTurnBegin(msg.sessionId);
                },
                onTurnEnd: () => {
                  deps.mcpRuntime.notifyTurnEnd(msg.sessionId);
                },
              }
            : undefined;

          const d = msg.extensions.platform?.discord;
          const userMetadata: Record<string, unknown> = {
            ...extraUserMetadata,
            discordMessageId: msg.id,
            ...(d
              ? {
                  discordAuthorId: d.authorId,
                  discordAuthorIsBot: d.authorIsBot,
                  discordIsSelf: d.isSelf,
                  discordIsOwner: d.isOwner,
                }
              : {}),
          };

          // If streaming is enabled, post the placeholder ("…") BEFORE starting the
          // typing indicator. Discord cancels typing when a bot posts a message, so
          // posting the placeholder inside withTypingIndicator would kill the indicator.
          const preStartedStreamHandle = await startStreamHandleWithBar(
            {
              logger: deps.logger,
              env: deps.env,
              statusBarDep: deps.statusBarDep,
              streamingForSession: deps.discord.streamingForSession,
            },
            msg.sessionId,
          );

          // Resolve the model once per inbound turn; both image options below
          // are derived from it.
          const turnCfg = inboundTurnConfig(deps);
          const turnModel = resolveModel(deps.db, turnCfg, {
            sessionId: msg.sessionId,
          });

          await deps.adapter.withTypingIndicator(msg.sessionId, async () => {
            await deps.orchestrator.orchestrateInboundTurn({
              sessionId: msg.sessionId,
              replyToMessageId: msg.id,
              preStartedStreamHandle,
              onStreamStartFailed: (errMsg) => {
                deps.logger.warn("discord.platform.stream_start_failed", {
                  err: errMsg,
                });
              },
              mcpLifecycle,
              logContext: { sessionId: msg.sessionId },
              onTurnExecutionFailed: (e) => {
                deps.logger.warn("discord.platform.turn_failed", {
                  err: String(e),
                  sessionId: msg.sessionId,
                });
              },
              attachments,
              imageBlockCodec: (() => {
                const kind = turnModel?.provider?.kind;
                if (
                  kind === "openai-compatible" ||
                  kind === "anthropic-messages" ||
                  kind === "gemini"
                ) {
                  return getImageBlockCodec(kind);
                }
                return undefined;
              })(),
              imageUrlPassthrough:
                turnModel !== null &&
                turnModel.provider.kind !== "gemini" &&
                turnModel.provider.imageUrlPassthrough === true,
              formatAttachmentMetadata,
              workspacePath: session.workspacePath,
              messageId: msg.id,
              // post-turn delivery runs outside the queue entry so a hung platform edit cannot wedge the session's turn queue
              detachPostTurnDelivery: true,
              ...(session.runtimeUid !== undefined && session.runtimeGid !== undefined
                ? { creds: { uid: session.runtimeUid, gid: session.runtimeGid } }
                : {}),
              buildTurn: async () => {
                const _mcpCtx = await deps.mcpRuntime.resolveContext(msg.sessionId);
                return {
                  db: deps.db,
                  sessionId: msg.sessionId,
                  session,
                  transcript: deps.transcript,
                  toolRuns: deps.toolRuns,
                  userContent,
                  userMetadata,

                  env: deps.env,
                  config: deps.config,
                  policyEngine: deps.policyEngine,
                  getHitlConfig: deps.getHitlConfig,
                  hitl: {
                    bypassUpTo: resolveSessionBypassUpTo(msg.sessionId, deps.config),
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
                  resolveMcpContext: deps.mcpRuntime.resolveContext,
                };
              },
            });
          });
        },
        {
          onQueued: () => queuedIndicator.markQueued(),
          onDequeued: () => {
            void queuedIndicator.clear();
          },
        },
      )
      .catch((e) => {
        deps.logger.warn("discord.platform.user_turn_failed", {
          err: String(e),
          sessionId: msg.sessionId,
        });
      });
  }

  return {
    dispatchChained,
    stop: async () => {
      const inFlightChains = [...chainTail.values()];
      chainTail.clear();
      await Promise.all(inFlightChains);
    },
  };
}
