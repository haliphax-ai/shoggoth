import { randomUUID } from "node:crypto";
import { getImageBlockCodec } from "@shoggoth/models";
import type Database from "better-sqlite3";
import { createOutboundMessage, type InternalMessage } from "@shoggoth/messaging";
import type { ModelInvocationParams } from "@shoggoth/models";
import {
  DEFAULT_HITL_CONFIG,
  formatAgentIdentityPrefix,
  parseAgentSessionUrn,
  type ShoggothConfig,
  type SystemContext,
} from "@shoggoth/shared";
import {
  createTurnBannerCollector,
  registerActiveTurnSurface,
  createCoalescingStreamPusher,
  createThinkingOutput,
  createHitlPendingResolutionStack,
  createPolicyEngine,
  createSessionStore,
  createTranscriptStore,
  createToolRunStore,
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
  parseSessionSegmentInlineCommand,
  sessionSegmentStartupUserContent,
  resolveSessionBypassUpTo,
  executeSessionAgentTurn,
  createSessionMcpRuntime,
  defaultPlatformAssistantDeps,
  createQueuedMessageIndicator,
  getTurnQueue,
  getStatusBarStats,
  createStatusBarTurnTracker,
  formatAssistantReply,
  routeReaction,
  formatGlobalReactionEventContext,
  formatAdhocReactionEventContext,
  PresentationTurnOrchestrator,
  type TieredTurnQueue,
  type HitlPendingStack,
  type PolicyEngine,
  type HitlConfigRef,
  type ExecuteSessionAgentTurnInput,
  type SessionAgentTurnResult,
  type SessionModelTurnDelivery,
  type StatusBarSnapshot,
  type TurnStatusBarTracker,
  type StreamHandle,
  type OobTurnBannerHandle,
  type PlatformAssistantDeps,
  resolveModel,
  shouldSkipThreadSessionSentinel,
} from "@shoggoth/daemon/lib";
import type { HitlNotifier, PendingActionRow, Logger, HitlAutoApproveGate } from "./daemon-types";
import { daemonNotice } from "./notices";
import type { DiscordMessagingRuntime } from "./bridge";
import { mergeOrchestratorEnv, resolveDiscordOwnerUserId } from "./config";
import { registerDiscordHitlNoticeAndAddReactions } from "./hitl/reaction-wiring";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { buildHitlQueuedNoticeLines, createDiscordHitlNotifier } from "./hitl/notifier";
import { sliceDiscordPlatformMessageBody } from "./errors";
import { formatAttachmentMetadata } from "./attachment-metadata";
import { DiscordPlatformAdapter } from "./discord-platform-adapter";
import { resolveStatusBarConfig, type ResolvedStatusBarConfig } from "@shoggoth/shared";
import type { CruiseControlHandle } from "@shoggoth/shared";
import { renderDiscordStatusBar } from "./status-bar";

/** Minimal status-bar dep: config from resolveStatusBarConfig, render from renderDiscordStatusBar,
 *  attachSink for live-bar stream wrapping, and stats seeded from session_stats (turn.db is
 *  unavailable when the orchestrator creates the tracker); passed to the presentation orchestrator. */
export function buildStatusBarDep(
  db: Database.Database,
  cfg: ResolvedStatusBarConfig,
  cruiseControlActive?: (sessionId: string) => boolean,
): {
  config: ResolvedStatusBarConfig;
  render: (snap: StatusBarSnapshot, c: ResolvedStatusBarConfig) => string;
  attachSink: (h: StreamHandle) => { setStatusBar(line: string | null): Promise<void> };
  stats: (sessionId: string) => {
    sequence: number;
    compactions: number;
    context?: { currentTokens: number; totalTokens?: number };
  };
  cruiseControlActive?: (sessionId: string) => boolean;
} {
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
    // Live cruise-control activity provider — re-read on every render.
    ...(cruiseControlActive ? { cruiseControlActive } : {}),
  };
}

function pickDiscordAssistantDeps(
  input?: Partial<PlatformAssistantDeps> & {
    readonly hitlNotifier?: HitlNotifier;
  },
): PlatformAssistantDeps {
  if (!input) return defaultPlatformAssistantDeps;
  const { hitlNotifier: _hitlNotifier, ...rest } = input;
  void _hitlNotifier;
  return { ...defaultPlatformAssistantDeps, ...rest };
}

/** Spread into a turn's `hitl` object to enable cruise control for the loop. */
function cruiseControlToolLoopHook(opts: DiscordPlatformOptions) {
  const cruise = opts.cruiseControl;
  if (!cruise) return {};
  return {
    cruiseControl: {
      isActive: (sessionId: string) => cruise.store.isActive(sessionId),
      judge: cruise.judge,
    },
  };
}

/** Spread into a status-bar tracker creation to render the 🚗 section. */
function cruiseStatusBarProvider(opts: DiscordPlatformOptions, sessionId: string) {
  const cruise = opts.cruiseControl;
  return cruise ? { cruiseControlActive: () => cruise.store.isActive(sessionId) } : {};
}

// Re-export presentation-layer formatting helpers for backward compatibility.
export { formatDegradedPrefix as formatDiscordPlatformDegradedPrefix } from "@shoggoth/daemon/lib";
export { formatModelTagFooter as formatDiscordPlatformModelTagFooter } from "@shoggoth/daemon/lib";

export interface DiscordPlatformOptions {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly policyEngine?: PolicyEngine;
  readonly hitlConfigRef?: HitlConfigRef;
  readonly hitlPending?: HitlPendingStack;
  readonly logger: Logger;
  readonly discord: DiscordMessagingRuntime;
  readonly configRef?: { current: ShoggothConfig };
  readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
  /** Cruise control (HITL auto-pilot): per-session store + judge. */
  readonly cruiseControl?: CruiseControlHandle;
  readonly env?: NodeJS.ProcessEnv;
  readonly deps?: Partial<PlatformAssistantDeps> & {
    readonly hitlNotifier?: HitlNotifier;
  };
}

export interface DiscordPlatformHandle {
  readonly stop: () => Promise<void>;
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: SystemContext;
    readonly delivery: SessionModelTurnDelivery;
    readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
    readonly statusBarSink?: { setStatusBar: (line: string | null) => Promise<void> };
  }) => Promise<SessionAgentTurnResult>;
  readonly oobTurnBanner: {
    begin: (input: {
      readonly sessionId: string;
      readonly processing: string;
    }) => Promise<OobTurnBannerHandle | undefined>;
    finish: (input: {
      readonly handle: OobTurnBannerHandle;
      readonly terminal: string;
      readonly content?: string;
    }) => Promise<void>;
  };
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  readonly announcePersistentSubagentSessionEnded: (input: {
    readonly sessionId: string;
    readonly reason: "ttl_expired" | "killed";
  }) => void;
  readonly handleReactionPassthrough: (ev: {
    readonly sessionId: string;
    readonly messageContent: string;
    readonly messageTimestamp: number;
    readonly emoji: string;
    readonly userId: string;
  }) => Promise<void>;
  /** Pin a message in the given channel. */
  readonly pinMessage: (input: {
    readonly channelId: string;
    readonly messageId: string;
  }) => Promise<void>;
  /** The PlatformAdapter instance for this Discord platform. */
  readonly adapter: DiscordPlatformAdapter;
}

export async function startDiscordPlatform(
  opts: DiscordPlatformOptions,
): Promise<DiscordPlatformHandle> {
  const configForOwnerGate = (): ShoggothConfig => opts.configRef?.current ?? opts.config;
  const env =
    opts.env !== undefined
      ? mergeOrchestratorEnv(opts.config, opts.env)
      : mergeOrchestratorEnv(opts.config);
  const sessions = createSessionStore(opts.db);
  const transcript = createTranscriptStore(opts.db);
  const toolRuns = createToolRunStore(opts.db);
  const hitlStack = opts.hitlPending ?? createHitlPendingResolutionStack(opts.db);
  const { pending, waitForHitlResolution } = hitlStack;

  const assistantDeps = pickDiscordAssistantDeps(opts.deps);
  const hitlNotifier =
    opts.deps?.hitlNotifier ??
    createDiscordHitlNotifier({
      logger: opts.logger,
      env,
      discord: opts.discord,
      hitlDiscordNoticeRegistry: opts.hitlDiscordNoticeRegistry,
    });

  const engine = opts.policyEngine ?? createPolicyEngine(opts.config.policy, opts.config.agents);
  const getHitlConfig = (): ShoggothConfig["hitl"] =>
    opts.hitlConfigRef ? opts.hitlConfigRef.value : { ...DEFAULT_HITL_CONFIG, ...opts.config.hitl };

  const statusBarDep = buildStatusBarDep(
    opts.db,
    resolveStatusBarConfig(opts.configRef?.current ?? opts.config),
    (sessionId) => {
      const provider = cruiseStatusBarProvider(opts, sessionId).cruiseControlActive;
      return provider ? provider() : false;
    },
  );

  const mcpRuntime = await createSessionMcpRuntime({
    config: opts.config,
    db: opts.db,
    env,
    deps: {
      connectShoggothMcpServers: assistantDeps.connectShoggothMcpServers,
    },
  });

  const loopImpl = assistantDeps.runToolLoopImpl;
  const createToolClient = assistantDeps.createToolCallingClient;

  const turnQueue: TieredTurnQueue = getTurnQueue();
  const chainTail = new Map<string, Promise<void>>();
  const subagentBusUnsubs: (() => void)[] = [];

  // Create the PlatformAdapter for Discord
  const adapter = new DiscordPlatformAdapter({
    discord: opts.discord,
    logger: opts.logger,
    hitlDiscordNoticeRegistry: opts.hitlDiscordNoticeRegistry,
  });

  // Create the PresentationTurnOrchestrator — delegates formatting, streaming,
  // and error presentation to the presentation layer.
  const streamEnabled = () => env.SHOGGOTH_DISCORD_STREAM === "1";
  const streamMinMs = () => {
    const raw = Number(env.SHOGGOTH_DISCORD_STREAM_MIN_MS ?? 400);
    return Number.isFinite(raw) ? Math.max(0, raw) : 400;
  };

  const orchestrator = new PresentationTurnOrchestrator({
    config: opts.config,
    configRef: opts.configRef,
    env,
    adapter,
    get streamingIntervalMs() {
      return streamEnabled() ? streamMinMs() : 0;
    },
    errorReplyPrefix: "⚠️ ",
    statusBar: statusBarDep,
  });

  const unsubs = opts.discord.routes.map((route) =>
    opts.discord.bus.subscribe(route.sessionId, (msg) => {
      void dispatchChained(route.sessionId, msg).catch((e) => {
        opts.logger.error("discord.platform.dispatch_failed", {
          err: String(e),
        });
      });
    }),
  );

  /** Send the in-session HITL queued notice and wire up approval reactions. */
  async function sendHitlQueuedNotice(
    row: PendingActionRow,
    delivery: {
      readonly sessionId: string;
      readonly userId?: string;
      readonly replyToMessageId?: string;
    },
  ): Promise<void> {
    const ref = await opts.discord.outbound.sendDiscord(
      createOutboundMessage({
        id: randomUUID(),
        sessionId: delivery.sessionId,
        userId: delivery.userId,
        createdAt: new Date().toISOString(),
        body: sliceDiscordPlatformMessageBody(buildHitlQueuedNoticeLines(row).join("\n")),
        extensions: { replyToMessageId: delivery.replyToMessageId },
      }),
    );
    if (opts.hitlDiscordNoticeRegistry) {
      await registerDiscordHitlNoticeAndAddReactions({
        transport: opts.discord.discordRestTransport,
        channelId: ref.channelId,
        messageId: ref.messageId,
        row,
        registry: opts.hitlDiscordNoticeRegistry,
        logger: opts.logger,
      });
    }
  }

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

    const session = sessions.getById(msg.sessionId);
    if (!session) {
      opts.logger.warn("discord.platform.no_session", {
        sessionId: msg.sessionId,
        hint: "no SQLite session row for this route; the daemon auto-bootstraps the main agent session on startup — check config and restart",
      });
      return;
    }

    const ownerSnowflake = resolveDiscordOwnerUserId(configForOwnerGate());
    if (ownerSnowflake && !session.subagentMode) {
      if (!msg.extensions.platform?.discord?.isOwner) return;
    }

    const segmentMode = parseSessionSegmentInlineCommand(text);
    if (segmentMode) {
      try {
        if (segmentMode === "new") {
          applySessionContextSegmentNew({
            db: opts.db,
            sessions,
            pending,
            sessionId: msg.sessionId,
          });
        } else {
          applySessionContextSegmentReset({
            db: opts.db,
            sessions,
            pending,
            sessionId: msg.sessionId,
          });
        }
      } catch (e) {
        opts.logger.warn("discord.platform.segment_command_failed", {
          err: String(e),
          sessionId: msg.sessionId,
          mode: segmentMode,
        });
        try {
          await opts.discord.outbound.sendDiscord(
            createOutboundMessage({
              id: randomUUID(),
              sessionId: msg.sessionId,
              userId: msg.userId,
              createdAt: new Date().toISOString(),
              body: sliceDiscordPlatformMessageBody(
                daemonNotice("segment-command-error", {
                  mode: segmentMode,
                  error: String(e),
                }),
              ),
              extensions: { replyToMessageId: msg.id },
            }),
          );
        } catch {
          /* ignore */
        }
        return;
      }
      const sessionAfter = sessions.getById(msg.sessionId);
      if (!sessionAfter) return;
      const segShort = sessionAfter.contextSegmentId.slice(0, 8);
      const ack =
        segmentMode === "new"
          ? daemonNotice("segment-ack-new", { segmentPreview: segShort })
          : daemonNotice("segment-ack-reset", { segmentPreview: segShort });
      try {
        await opts.discord.outbound.sendDiscord(
          createOutboundMessage({
            id: randomUUID(),
            sessionId: msg.sessionId,
            userId: msg.userId,
            createdAt: new Date().toISOString(),
            body: sliceDiscordPlatformMessageBody(ack),
            extensions: { replyToMessageId: msg.id },
          }),
        );
      } catch (e) {
        opts.logger.warn("discord.platform.segment_ack_failed", {
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
    session: NonNullable<ReturnType<typeof sessions.getById>>,
    userContent: string,
    extraUserMetadata: Record<string, unknown>,
    attachments?: readonly import("@shoggoth/messaging").MessageAttachment[],
  ): Promise<void> {
    // Thread sentinel: a thread subagent session's first "." message only starts
    // the thread (the creation status message was already posted at thread-create
    // time), so exit before anything turn-shaped happens — no streaming placeholder
    // ("…"), no typing indicator, no queue entry. The core check in
    // runInboundSessionTurn runs after the platform has already posted the
    // placeholder and started typing, so it cannot suppress them. Attachment-bearing
    // "." messages keep their existing behavior: their enriched content is not ".",
    // so the core sentinel check does not match them either. The session stays
    // bound and later messages fire turns normally.
    if (
      !attachments?.length &&
      shouldSkipThreadSessionSentinel({
        db: opts.db,
        sessions,
        sessionId: msg.sessionId,
        body: userContent,
      })
    ) {
      opts.logger.debug("discord.platform.thread_sentinel_skipped", {
        sessionId: msg.sessionId,
        messageId: msg.id,
      });
      return;
    }

    // Queued-message indicator (issue #399): a ⏳ reaction on the operator's
    // message while it waits behind an in-flight turn (reply/post fallback for
    // platforms without reactions), removed when the queued turn starts or the
    // entry is dropped.
    const queuedIndicator = createQueuedMessageIndicator({
      sessionId: msg.sessionId,
      messageId: msg.id,
      capabilities: adapter.capabilities,
      logger: opts.logger,
      resolveChannelId: (sid) => opts.discord.resolveOutboundChannelIdForSession?.(sid),
      sendReply: async (body) => {
        await opts.discord.outbound.sendDiscord(
          createOutboundMessage({
            id: randomUUID(),
            sessionId: msg.sessionId,
            userId: msg.userId,
            createdAt: new Date().toISOString(),
            body: sliceDiscordPlatformMessageBody(body),
            extensions: { replyToMessageId: msg.id },
          }),
        );
      },
      sendPost: async (body) => {
        await opts.discord.outbound.sendDiscord(
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

    void turnQueue
      .enqueue(
        msg.sessionId,
        "user",
        userMessageLabel,
        async () => {
          const hitlReplyInSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";

          const mcpLifecycle = mcpRuntime.trackInstanceIdle
            ? {
                onTurnBegin: () => {
                  mcpRuntime.notifyTurnBegin(msg.sessionId);
                },
                onTurnEnd: () => {
                  mcpRuntime.notifyTurnEnd(msg.sessionId);
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
          let preStartedStreamHandle: import("@shoggoth/daemon/lib").StreamHandle | undefined;
          if (streamEnabled()) {
            const streamingOutbound = opts.discord.streamingForSession(msg.sessionId);
            if (streamingOutbound) {
              try {
                const raw = await streamingOutbound.start();
                // Wrap the raw stream handle with the status-bar sink so the bar
                // can be applied to the in-flight message (mirrors the
                // messaging_surface path below). Delegates to any native
                // setStatusBar on the handle.
                if (statusBarDep.config.enabled) {
                  statusBarDep.attachSink(raw as unknown as StreamHandle);
                }
                preStartedStreamHandle = {
                  setFullContent: (text: string) => raw.setFullContent(text),
                  pushUpdate: (text: string) => raw.pushUpdate(text),
                  ...(raw.setStatusBar
                    ? { setStatusBar: (line: string | null) => raw.setStatusBar!(line) }
                    : {}),
                  // Teardown pass-through: the abort path must be able to
                  // finalize the underlying handle through this wrapper.
                  ...(raw.close ? { close: () => raw.close!() } : {}),
                };
              } catch (e) {
                opts.logger.warn("discord.platform.stream_start_failed", {
                  err: String(e),
                });
              }
            }
          }

          // Resolve the model once per inbound turn; both image options below
          // are derived from it.
          const turnCfg = opts.configRef?.current ?? opts.config;
          const turnModel = resolveModel(opts.db, turnCfg, {
            sessionId: msg.sessionId,
          });

          await adapter.withTypingIndicator(msg.sessionId, async () => {
            await orchestrator.orchestrateInboundTurn({
              sessionId: msg.sessionId,
              replyToMessageId: msg.id,
              preStartedStreamHandle,
              onStreamStartFailed: (errMsg) => {
                opts.logger.warn("discord.platform.stream_start_failed", {
                  err: errMsg,
                });
              },
              mcpLifecycle,
              logContext: { sessionId: msg.sessionId },
              onTurnExecutionFailed: (e) => {
                opts.logger.warn("discord.platform.turn_failed", {
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
                const _mcpCtx = await mcpRuntime.resolveContext(msg.sessionId);
                return {
                  db: opts.db,
                  sessionId: msg.sessionId,
                  session,
                  transcript,
                  toolRuns,
                  userContent,
                  userMetadata,

                  env,
                  config: opts.config,
                  policyEngine: engine,
                  getHitlConfig,
                  hitl: {
                    bypassUpTo: resolveSessionBypassUpTo(msg.sessionId, opts.config),
                    pending,
                    clock: { nowMs: () => Date.now() },
                    newPendingId: () => randomUUID(),
                    waitForHitlResolution,
                    hitlNotifier,
                    autoApprove: opts.hitlAutoApproveGate,
                    ...cruiseControlToolLoopHook(opts),
                    ...(hitlReplyInSession
                      ? {
                          afterHitlQueued: (row: PendingActionRow) =>
                            sendHitlQueuedNotice(row, {
                              sessionId: msg.sessionId,
                              userId: msg.userId,
                              replyToMessageId: msg.id,
                            }),
                        }
                      : {}),
                  },
                  loopImpl,
                  createToolCallingClient: createToolClient,
                  resolveMcpContext: mcpRuntime.resolveContext,
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
        opts.logger.warn("discord.platform.user_turn_failed", {
          err: String(e),
          sessionId: msg.sessionId,
        });
      });
  }

  async function runSessionModelTurn(input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: SystemContext;
    readonly delivery: SessionModelTurnDelivery;
    readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
    readonly statusBarSink?: { setStatusBar: (line: string | null) => Promise<void> };
  }): Promise<SessionAgentTurnResult> {
    const sid = input.sessionId.trim();
    const sessionRow = sessions.getById(sid);
    if (!sessionRow || sessionRow.status === "terminated") {
      throw new Error(`session not available: ${sid}`);
    }
    let turnResult!: SessionAgentTurnResult;
    await turnQueue.enqueue(sid, "system", input.systemContext?.kind ?? "system", async () => {
      opts.logger.debug("platform.turn_queue_acquired", { sessionId: sid });
      opts.logger.debug("platform.mcp_context_resolving", { sessionId: sid });
      const mcpCtx = await mcpRuntime.resolveContext(sid);
      opts.logger.debug("platform.mcp_context_resolved", {
        sessionId: sid,
        toolCount: mcpCtx.toolsLoop.length,
      });
      const userMetadata = input.userMetadata ?? {};
      const hitlReplyInSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";
      const buildAfterHitlQueued = (delivery: {
        readonly userId: string;
        readonly replyToMessageId?: string;
      }) =>
        hitlReplyInSession
          ? (row: PendingActionRow) =>
              sendHitlQueuedNotice(row, {
                sessionId: sid,
                userId: delivery.userId,
                replyToMessageId: delivery.replyToMessageId,
              })
          : undefined;

      // One tracker for the messaging_surface turn: the live bar AND the
      // terminal bar are its snapshots rendered by the same renderer (the only
      // live/terminal difference is the phase emoji). Captures until the stream
      // handle exists; attachSink flushes the ⏳ line onto the placeholder.
      let surfaceTracker: TurnStatusBarTracker | undefined;
      let thinkingOutput: ReturnType<typeof createThinkingOutput> | undefined;
      let surfaceStreamPusher: ReturnType<typeof createCoalescingStreamPusher> | undefined;
      // Declared here (not in the messaging_surface branch) so the abort
      // handler inside executeTurn can finalize the in-flight message handle.
      let surfaceStreamHandle: StreamHandle | undefined;
      // Round-settled prose of earlier rounds for the live display when the
      // thinking composer is disabled (showThinking === false surfaces still
      // show every round, separated by the transcript's blank line).
      let surfacePriorRoundsProse = "";
      // In-turn banner anchors: the runner's live position (committed prose
      // segments / tool calls) captured at notice-fire time.
      let surfaceCommittedProseSegments = 0;
      let surfaceToolCalls = 0;
      const executeTurn = (
        afterHitlQueued?: (row: PendingActionRow) => void | Promise<void>,
        streamOverride?: ExecuteSessionAgentTurnInput["stream"],
      ) =>
        executeSessionAgentTurn({
          db: opts.db,
          sessionId: sid,
          session: sessionRow,
          transcript,
          toolRuns,
          userContent: input.userContent,
          userMetadata,
          systemContext: input.systemContext,
          modelInvocationOverride: input.modelInvocationOverride,

          env,
          config: opts.config,
          policyEngine: engine,
          getHitlConfig,
          hitl: {
            bypassUpTo: resolveSessionBypassUpTo(sid, opts.config),
            pending,
            clock: { nowMs: () => Date.now() },
            newPendingId: () => randomUUID(),
            waitForHitlResolution,
            hitlNotifier,
            autoApprove: opts.hitlAutoApproveGate,
            ...cruiseControlToolLoopHook(opts),
            ...(afterHitlQueued ? { afterHitlQueued } : {}),
          },
          loopImpl,
          createToolCallingClient: createToolClient,
          resolveMcpContext: mcpRuntime.resolveContext,
          ...(streamOverride ? { stream: streamOverride } : {}),
          // Forward turn events into the tracker so the live bar re-renders
          // mid-turn (thinking / tool count / HITL pause / compaction /
          // context fill). `onTurnAborted` stops the stream pusher and
          // freezes the tracker even when the aborted turn promise never
          // settles (hung model call).
          ...(surfaceTracker || thinkingOutput || surfaceStreamPusher
            ? {
                events: {
                  onThinkingDelta: (ev: { accumulated: string; round: number }) => {
                    if (thinkingOutput) {
                      const display = thinkingOutput.onThinking(ev);
                      if (surfaceStreamPusher) {
                        surfaceStreamPusher.push(display.trim() ? display : "…");
                      }
                    }
                    surfaceTracker?.onThinkingDelta?.(ev.accumulated);
                  },
                  onToolCall: (ev) => {
                    surfaceToolCalls += 1;
                    surfaceTracker?.onToolCall?.(ev);
                  },
                  onHitlQueued: (call) => surfaceTracker?.onHitlQueued?.(call),
                  onCompaction: () => surfaceTracker?.onCompaction?.(),
                  onContextUpdate: (update) => surfaceTracker?.onContextUpdate?.(update),
                  // Abort while the model call may still be streaming (or
                  // hung): stop the producers immediately — post-turn delivery
                  // never runs for a promise that never settles, so nothing
                  // else would ever stop the edits. finish("aborted") freezes
                  // the tracker at its terminal render (🛑); if the turn
                  // still settles later, delivery reuses the captured line.
                  onTurnAborted: () => {
                    surfaceStreamPusher?.stop();
                    // Deterministic teardown: no producer (late deltas,
                    // deferred-abort delivery, stray renders) may edit the
                    // aborted turn's message after this point.
                    surfaceStreamHandle?.close?.();
                    if (surfaceTracker) {
                      void surfaceTracker.finish("aborted").catch((e) => {
                        opts.logger.warn("discord.platform.status_bar_abort_finish_failed", {
                          sessionId: sid,
                          err: String(e),
                        });
                      });
                    }
                  },
                },
              }
            : {}),
        });

      if (input.delivery.kind === "messaging_surface") {
        const delivery = input.delivery;

        // Snapshot stats BEFORE the turn runs: executing the turn increments
        // session_stats.turn_count, and the bar must report the sequence of
        // the very turn it belongs to (not the next one).
        if (statusBarDep.config.enabled) {
          surfaceTracker = createStatusBarTurnTracker({
            cfg: statusBarDep.config,
            render: statusBarDep.render,
            stats: getStatusBarStats(opts.db, sid),
            ...cruiseStatusBarProvider(opts, sid),
          });
        }

        // When streaming is enabled, post the placeholder ("…") BEFORE starting
        // the typing indicator — Discord cancels typing when a bot posts a
        // message — and coalesce model text deltas into live edits of that
        // message, matching the standard inbound-turn pathway.
        thinkingOutput =
          (opts.configRef?.current ?? opts.config).platforms?.showThinking === false
            ? undefined
            : createThinkingOutput();
        if (streamEnabled()) {
          const streamingOutbound = opts.discord.streamingForSession(sid);
          if (streamingOutbound) {
            try {
              const raw = await streamingOutbound.start();
              // Wrap the raw stream handle with the status-bar sink so the bar
              // can be applied to the in-flight message (test: raw handles carry
              // setStatusBar). Delegates to any native setStatusBar on the handle.
              if (statusBarDep.config.enabled) {
                statusBarDep.attachSink(raw as unknown as StreamHandle);
              }
              surfaceStreamHandle = {
                setFullContent: (text: string) => raw.setFullContent(text),
                pushUpdate: (text: string) => raw.pushUpdate(text),
                ...(raw.setStatusBar
                  ? { setStatusBar: (line: string | null) => raw.setStatusBar!(line) }
                  : {}),
                // Teardown pass-through: the abort path must be able to
                // finalize the underlying handle through this wrapper.
                ...(raw.close ? { close: () => raw.close!() } : {}),
              };
              // Wire the tracker's live target; the tracker flushes its
              // captured ⏳ line so the placeholder carries the bar from turn
              // start (capture-fallback until this handle exists).
              surfaceTracker?.attachSink({
                setStatusBar: (line: string | null) =>
                  surfaceStreamHandle?.setStatusBar
                    ? surfaceStreamHandle.setStatusBar(line)
                    : Promise.resolve(),
              });
            } catch (e) {
              opts.logger.warn("discord.platform.stream_start_failed", {
                err: String(e),
                sessionId: sid,
              });
            }
          }
        }
        surfaceStreamPusher = surfaceStreamHandle
          ? createCoalescingStreamPusher((s) => surfaceStreamHandle!.pushUpdate(s), streamMinMs())
          : undefined;

        // In-turn surface notices: banners landing mid-turn are folded into
        // this messaging_surface turn's output (streamed display and final
        // body) instead of being posted as standalone messages. A single
        // per-turn banner manager owns capture (anchored to the runner's live
        // position), live rendering, and terminal splicing.
        const surfaceBanners = createTurnBannerCollector({
          captureAnchor: () => ({
            committedProseSegments: surfaceCommittedProseSegments,
            toolCalls: surfaceToolCalls,
          }),
          onNotice: () => {
            if (surfaceStreamPusher) pushDisplay(surfaceDisplay || "…");
          },
        });
        let surfaceDisplay = "";
        const pushDisplay = (display: string): void => {
          surfaceDisplay = display;
          if (!surfaceStreamPusher) return;
          surfaceStreamPusher.push(surfaceBanners.liveBody(display));
        };
        const surfaceUnregister = registerActiveTurnSurface(sid, surfaceBanners).unregister;

        try {
          await adapter.withTypingIndicator(sid, async () => {
            turnResult = await executeTurn(
              buildAfterHitlQueued(delivery),
              surfaceStreamPusher
                ? {
                    streamModel: true,
                    onModelTextDelta: (ev: { accumulated: string; round: number }) => {
                      const display = thinkingOutput
                        ? thinkingOutput.onText(ev)
                        : surfacePriorRoundsProse + ev.accumulated;
                      pushDisplay(display.trim() ? display : "…");
                      // Prose phase (💬) on the live bar.
                      surfaceTracker?.onProse?.(ev.accumulated);
                    },
                    onModelRoundEnd: (ev: { round: number; content: string }) => {
                      // A settled round commits exactly one prose segment when
                      // its content is non-blank — the same condition that
                      // admits it into the composed turn prose — so anchors
                      // map 1:1 onto final body positions.
                      if (ev.content.trim()) surfaceCommittedProseSegments += 1;
                      let display: string;
                      if (thinkingOutput) {
                        display = thinkingOutput.endRound(ev);
                      } else {
                        if (ev.content) {
                          surfacePriorRoundsProse += surfacePriorRoundsProse
                            ? `\n\n${ev.content}`
                            : ev.content;
                        }
                        display = surfacePriorRoundsProse;
                      }
                      pushDisplay(display.trim() ? display : "…");
                    },
                  }
                : streamEnabled() || thinkingOutput
                  ? { streamModel: true }
                  : undefined,
            );
            const cfg = opts.configRef?.current ?? opts.config;
            // Compose the body from the turn's full prose — every assistant
            // text segment of this turn, in order — so prose → tools → prose
            // turns deliver ALL segments, not only the last one that
            // latestAssistantText carries. Both delivery paths (streamed and
            // at-once) deliver this same composition.
            const replyText = turnResult.assistantTurnProse ?? turnResult.latestAssistantText;
            const formattedBody = formatAssistantReply(
              cfg,
              sid,
              env,
              replyText,
              turnResult.failoverMeta,
            );
            const fullBody = surfaceBanners.terminalBody(
              thinkingOutput?.render(formattedBody) ?? formattedBody,
              { segments: replyText.split("\n\n") },
            );
            // ONE terminal composition: the tracker's finish() renders the
            // frozen bar (✅/🛑/❌) through the same renderer as the live bar and
            // returns the line for delivery — the terminal snapshot carries this
            // turn's real tool-call count (the tracker, not a stats-derived
            // parallel composition, is the source).
            const outcome =
              turnResult.outcome === "aborted" ||
              turnResult.outcome === "failed" ||
              turnResult.outcome === "canceled"
                ? turnResult.outcome
                : "finished";
            const barLine = surfaceTracker ? await surfaceTracker.finish(outcome) : undefined;
            if (surfaceStreamPusher && surfaceStreamHandle) {
              await surfaceStreamPusher.flush();
              // Clear the in-flight handle's active-bar state first — a
              // state-only operation that makes no edit — so the delivery edit
              // below (whose body already carries barLine) lands the bar
              // exactly once. Never block delivery.
              if (barLine && surfaceStreamHandle.setStatusBar) {
                try {
                  await surfaceStreamHandle.setStatusBar(null);
                } catch (e) {
                  opts.logger.warn("discord.platform.status_bar_clear_failed", {
                    err: String(e),
                    sessionId: sid,
                  });
                }
              }
              // ONE terminal delivery: always replace the live streamed display
              // with fullBody — the turn-scoped composition (every prose segment
              // of THIS turn via assistantTurnProse, rendered thinking quotes,
              // formatted decorations). The live display is only a view of the
              // in-flight accumulation and may carry cross-round artifacts
              // (round restarts after steering/failover in a session-long tool
              // loop); the delivered message must be the clean turn record.
              await surfaceStreamHandle.setFullContent(
                barLine ? `${fullBody}\n\n${barLine}` : fullBody,
              );
              // Stream edits can't carry file attachments — send as follow-up.
              const attachments = turnResult.showAttachments;
              if (attachments?.length) {
                await adapter.sendBody(sid, "", { attachments: [...attachments] });
              }
            } else {
              await adapter.sendBody(sid, barLine ? `${fullBody}\n\n${barLine}` : fullBody, {
                replyTo: delivery.replyToMessageId,
              });
            }
          });
          return;
        } finally {
          surfaceUnregister();
        }
      }
      let internalAfterHitlQueued: ((row: PendingActionRow) => void | Promise<void>) | undefined;
      if (sessionRow.parentSessionId && hitlReplyInSession) {
        const parentRow = sessions.getById(sessionRow.parentSessionId);
        const parentChannelId = parentRow
          ? opts.discord.resolveOutboundChannelIdForSession?.(parentRow.id)
          : undefined;
        if (parentChannelId) {
          const ownerUserId = resolveDiscordOwnerUserId(configForOwnerGate());
          internalAfterHitlQueued = (row: PendingActionRow) =>
            sendHitlQueuedNotice(row, {
              sessionId: sessionRow.parentSessionId!,
              userId: ownerUserId ?? "system",
            });
        }
      }

      // OOB banner surface (issue #363): when the caller passed a status-bar
      // sink, create the same tracker used for messaging_surface turns so the
      // live bar (starting / thinking / prose / tools) streams into the banner
      // message while this out-of-band turn executes. Stats are snapshotted
      // BEFORE the turn so the bar reports this turn's sequence.
      if (input.statusBarSink && statusBarDep.config.enabled) {
        surfaceTracker = createStatusBarTurnTracker({
          cfg: statusBarDep.config,
          render: statusBarDep.render,
          stats: getStatusBarStats(opts.db, sid),
          ...cruiseStatusBarProvider(opts, sid),
        });
        surfaceTracker.attachSink(input.statusBarSink);
      }

      opts.logger.debug("platform.executeTurn_calling", {
        sessionId: sid,
        delivery: input.delivery.kind,
      });
      const internalStreamModel =
        (opts.configRef?.current ?? opts.config).agents?.internalStreaming !== false;
      turnResult = await executeTurn(internalAfterHitlQueued, {
        streamModel: internalStreamModel,
      });

      // Freeze the bar at its terminal render (✅/🛑/❌) so the banner's final
      // edit carries the same terminal bar a normal turn would. The caller's
      // `oobTurnBanner.finish` clears the sink and edits the body afterwards.
      if (surfaceTracker) {
        const outcome =
          turnResult.outcome === "aborted" ||
          turnResult.outcome === "failed" ||
          turnResult.outcome === "canceled"
            ? turnResult.outcome
            : "finished";
        try {
          // Capture the rendered terminal bar line (the ONE terminal
          // composition) and attach it to the turn result so the caller can
          // hand it back to `oobTurnBanner.finish` for the final edit.
          const barLine = await surfaceTracker.finish(outcome);
          if (barLine) turnResult = { ...turnResult, statusBarLine: barLine };
        } catch (e) {
          opts.logger.warn("discord.platform.oob_status_bar_finish_failed", {
            sessionId: sid,
            err: String(e),
          });
        }
      }
    });
    return turnResult;
  }

  function subscribeSubagentSession(sessionId: string): () => void {
    const sid = sessionId.trim();
    const u = opts.discord.bus.subscribe(sid, (msg) => {
      void dispatchChained(sid, msg).catch((e) => {
        opts.logger.error("discord.platform.dispatch_failed", {
          err: String(e),
        });
      });
    });
    subagentBusUnsubs.push(u);
    return () => {
      u();
      const ix = subagentBusUnsubs.indexOf(u);
      if (ix >= 0) subagentBusUnsubs.splice(ix, 1);
    };
  }

  function announcePersistentSubagentSessionEnded(input: {
    readonly sessionId: string;
    readonly reason: "ttl_expired" | "killed";
  }): void {
    const row = sessions.getById(input.sessionId.trim());
    if (!row || row.subagentMode !== "persistent") return;
    const threadId = row.subagentPlatformThreadId?.trim();
    if (!threadId) return;
    const cfg = opts.configRef?.current ?? opts.config;
    const line =
      input.reason === "ttl_expired"
        ? daemonNotice("subagent-persistent-ended-ttl")
        : daemonNotice("subagent-persistent-ended-killed");
    const body = sliceDiscordPlatformMessageBody(
      `${formatAgentIdentityPrefix(cfg, input.sessionId)}${line}`,
    );
    void opts.discord.discordRestTransport.createMessage(threadId, { content: body }).catch((e) => {
      opts.logger.debug("discord.subagent.persistent_end_notice_failed", {
        sessionId: input.sessionId,
        err: String(e),
      });
    });
  }
  async function handleReactionPassthrough(ev: {
    readonly sessionId: string;
    readonly messageContent: string;
    readonly messageTimestamp: number;
    readonly emoji: string;
    readonly userId: string;
  }): Promise<void> {
    const cfg = opts.configRef?.current ?? opts.config;
    const agentId = parseAgentSessionUrn(ev.sessionId)?.agentId;
    const agentReactions = agentId ? cfg.agents?.list?.[agentId]?.reactions : undefined;

    const globalPassthrough = (agentReactions?.globalPassthrough ??
      (cfg as any).reactions?.globalPassthrough ?? [
        "\uD83D\uDC4D",
        "\uD83D\uDC4E",
        "\u2705",
        "\u274C",
      ]) as string[];

    const maxAgeMinutes = (agentReactions?.maxAgeMinutes ??
      (cfg as any).reactions?.maxAgeMinutes ??
      30) as number;

    const route = routeReaction({
      emoji: ev.emoji,
      messageContent: ev.messageContent,
      messageTimestamp: ev.messageTimestamp,
      nowMs: Date.now(),
      maxAgeMinutes,
      globalPassthrough,
    });

    if (route.kind === "discard") {
      opts.logger.debug("reaction.passthrough.discard", {
        sessionId: ev.sessionId,
        emoji: ev.emoji,
        reason: route.reason,
      });
      return;
    }

    let eventContext: string;
    if (route.kind === "adhoc") {
      eventContext = formatAdhocReactionEventContext(
        ev.emoji,
        route.legend.entries,
        ev.messageContent,
      );
    } else {
      eventContext = formatGlobalReactionEventContext(ev.emoji, ev.messageContent);
    }

    try {
      await runSessionModelTurn({
        sessionId: ev.sessionId,
        userContent: eventContext,
        systemContext: {
          kind: "reaction",
          summary: `Reaction ${ev.emoji} passthrough`,
        },
        delivery: { kind: "messaging_surface", userId: ev.userId },
      });
    } catch (e) {
      opts.logger.warn("reaction.passthrough.turn_failed", {
        err: String(e),
        sessionId: ev.sessionId,
      });
    }
  }

  /**
   * OOB turn banner surface (issue #363). `begin` posts a "processing" banner as
   * an editable message via the session's streaming outbound. That returns
   * `undefined` when the session isn't surface-bound or the platform can't edit
   * messages, in which case callers fall back to plain delivery. `finish` edits
   * the banner message in place with the terminal banner plus optional
   * `to_operator` content and the turn's terminal status-bar line, clearing
   * the live bar first so it isn't rendered twice.
   */
  const oobTurnBanner = {
    async begin(input: {
      readonly sessionId: string;
      readonly processing: string;
    }): Promise<OobTurnBannerHandle | undefined> {
      const streamingOutbound = opts.discord.streamingForSession(input.sessionId);
      if (!streamingOutbound) return undefined;
      try {
        const handle = await streamingOutbound.start();
        await handle.setFullContent(input.processing);
        return {
          sessionId: input.sessionId,
          setBody: async (text: string) => {
            await handle.setFullContent(text);
          },
          setStatusBar: async (line: string | null) => {
            if (handle.setStatusBar) await handle.setStatusBar(line);
          },
        };
      } catch (e) {
        opts.logger.warn("discord.oob_banner.begin_failed", {
          sessionId: input.sessionId,
          err: String(e),
        });
        return undefined;
      }
    },
    async finish(input: {
      readonly handle: OobTurnBannerHandle;
      readonly terminal: string;
      readonly content?: string;
      /** Terminal bar line (✅/🛑/❌) rendered by the turn's status-bar
       *  tracker; appended last so the banner matches every other turn
       *  surface. Omitted when the turn had no tracker. */
      readonly statusBar?: string;
    }): Promise<void> {
      // Clear the live bar (a state-only operation that makes no edit) so the
      // terminal body edit below lands the bar exactly once, mirroring the
      // messaging_surface delivery pattern.
      try {
        await input.handle.setStatusBar(null);
      } catch (e) {
        opts.logger.warn("discord.oob_banner.status_bar_clear_failed", {
          sessionId: input.handle.sessionId,
          err: String(e),
        });
      }
      // Edit the banner message in place via the handle captured at `begin`.
      // A missing `setBody` means the platform cannot edit messages, so there
      // is nothing to append to and we leave the processing banner as-is.
      if (!input.handle.setBody) return;
      try {
        // Compose terminal (+ optional content) then the terminal bar line
        // LAST — the same append order the messaging_surface delivery uses.
        const base = input.content ? `${input.terminal}\n\n${input.content}` : input.terminal;
        const body = input.statusBar ? `${base}\n\n${input.statusBar}` : base;
        await input.handle.setBody(body);
      } catch (e) {
        opts.logger.warn("discord.oob_banner.finish_failed", {
          sessionId: input.handle.sessionId,
          err: String(e),
        });
      }
    },
  };

  return {
    stop: async () => {
      for (const u of unsubs) u();
      for (const u of subagentBusUnsubs) u();
      subagentBusUnsubs.length = 0;
      const inFlightChains = [...chainTail.values()];
      chainTail.clear();
      await Promise.all(inFlightChains);
      await mcpRuntime.shutdown();
    },
    runSessionModelTurn,
    oobTurnBanner,
    subscribeSubagentSession,
    announcePersistentSubagentSessionEnded,
    handleReactionPassthrough,
    pinMessage: async (input: { readonly channelId: string; readonly messageId: string }) => {
      await opts.discord.discordRestTransport.pinMessage?.(input.channelId, input.messageId);
    },
    adapter,
  };
}
