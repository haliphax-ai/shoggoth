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
  createCoalescingStreamPusher,
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
  getTurnQueue,
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
  type StreamHandle,
  type PlatformAssistantDeps,
  resolveModel,
  shouldSkipThreadSessionSentinel,
} from "@shoggoth/daemon/lib";
import type { HitlNotifier, PendingActionRow, Logger, HitlAutoApproveGate } from "./daemon-types";
import { daemonNotice } from "./notices";
import type { DiscordMessagingRuntime } from "./bridge";
import { mergeOrchestratorEnv, resolveDiscordOwnerUserId } from "./config";
import { registerDiscordHitlNoticeAndAddReactions } from "./hitl/reaction-wiring";
import { formatTokens } from "./status-bar";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { buildHitlQueuedNoticeLines, createDiscordHitlNotifier } from "./hitl/notifier";
import { sliceDiscordPlatformMessageBody } from "./errors";
import { formatAttachmentMetadata } from "./attachment-metadata";
import { DiscordPlatformAdapter } from "./discord-platform-adapter";
import { resolveStatusBarConfig, type ResolvedStatusBarConfig } from "@shoggoth/shared";
import { renderDiscordStatusBar } from "./status-bar";

/** Minimal status-bar dep: config from resolveStatusBarConfig, render from renderDiscordStatusBar,
 *  and a no-op attachSink; passed to the presentation orchestrator when status is enabled. */
function buildStatusBarDep(cfg: ResolvedStatusBarConfig): {
  config: ResolvedStatusBarConfig;
  render: (snap: StatusBarSnapshot, c: ResolvedStatusBarConfig) => string;
  attachSink: (h: StreamHandle) => { setStatusBar(line: string | null): Promise<void> };
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
  };
}

interface StatusBarTurnStats {
  readonly sequence: number;
  readonly compactions: number;
  readonly inputTokens: number;
  readonly windowTokens: number | null;
}

/** Sequence from session_stats.turn_count, compactions from compaction_count,
 *  context from the latest per-call input tokens (input_tokens column). */
function readStatusBarStats(db: Database.Database, sessionId: string): StatusBarTurnStats {
  const row = db
    .prepare(
      `SELECT turn_count, compaction_count, input_tokens, context_window_tokens
       FROM session_stats WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        turn_count: number;
        compaction_count: number;
        input_tokens: number;
        context_window_tokens: number | null;
      }
    | undefined;
  return {
    sequence: row?.turn_count ?? 0,
    compactions: row?.compaction_count ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    windowTokens: row?.context_window_tokens ?? null,
  };
}

/** Terminal Discord status bar line (✅ ｜ 🔢 `n` ｜ 🗑️ `n` ｜ 🪟 `p%/y`). */
function renderStatusBarTerminalLine(s: StatusBarTurnStats): string {
  const sections = ["✅", `🔢 \`${s.sequence}\``, `🗑️ \`${s.compactions}\``];
  if (s.inputTokens > 0) {
    const hasWindow = s.windowTokens !== null && s.windowTokens > 0;
    const percent = hasWindow
      ? `${((s.inputTokens / s.windowTokens!) * 100).toFixed(1)}%`
      : undefined;
    const total = hasWindow ? `/${formatTokens(s.windowTokens!)}` : "";
    // Compact display: `31.4%/100K`; without a known window, just `31.4K`.
    sections.push(`🪟 \`${percent ? `${percent}${total}` : formatTokens(s.inputTokens)}\``);
  }
  return sections.join(" ｜ ");
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
  }) => Promise<SessionAgentTurnResult>;
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
    resolveStatusBarConfig(opts.configRef?.current ?? opts.config),
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

    // Fire-and-forget: push to the turn queue (synchronous) and return immediately.
    // Create a label with truncated message content for display in queue
    const maxLabelLength = 100;
    const userMessageLabel =
      userContent.length > maxLabelLength
        ? userContent.slice(0, maxLabelLength) + "..."
        : userContent;

    void turnQueue
      .enqueue(msg.sessionId, "user", userMessageLabel, async () => {
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
              preStartedStreamHandle = {
                setFullContent: (text: string) => raw.setFullContent(text),
                pushUpdate: (text: string) => raw.pushUpdate(text),
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
      })
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
            ...(afterHitlQueued ? { afterHitlQueued } : {}),
          },
          loopImpl,
          createToolCallingClient: createToolClient,
          resolveMcpContext: mcpRuntime.resolveContext,
          ...(streamOverride ? { stream: streamOverride } : {}),
        });

      if (input.delivery.kind === "messaging_surface") {
        const delivery = input.delivery;

        // When streaming is enabled, post the placeholder ("…") BEFORE starting
        // the typing indicator — Discord cancels typing when a bot posts a
        // message — and coalesce model text deltas into live edits of that
        // message, matching the standard inbound-turn pathway.
        let surfaceStreamHandle: StreamHandle | undefined;
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
              };
            } catch (e) {
              opts.logger.warn("discord.platform.stream_start_failed", {
                err: String(e),
                sessionId: sid,
              });
            }
          }
        }
        const surfaceStreamPusher = surfaceStreamHandle
          ? createCoalescingStreamPusher((s) => surfaceStreamHandle!.pushUpdate(s), streamMinMs())
          : undefined;

        await adapter.withTypingIndicator(sid, async () => {
          // Snapshot stats BEFORE the turn runs: executing the turn increments
          // session_stats.turn_count, and the bar must report the sequence of
          // the very turn it belongs to (not the next one).
          const statsAtTurnStart = statusBarDep.config.enabled
            ? readStatusBarStats(opts.db, sid)
            : undefined;
          turnResult = await executeTurn(
            buildAfterHitlQueued(delivery),
            surfaceStreamPusher
              ? {
                  streamModel: true,
                  onModelTextDelta: (t: string) => surfaceStreamPusher.push(t.trim() ? t : "…"),
                }
              : streamEnabled()
                ? { streamModel: true }
                : undefined,
          );
          const cfg = opts.configRef?.current ?? opts.config;
          const fullBody = formatAssistantReply(
            cfg,
            sid,
            env,
            turnResult.latestAssistantText,
            turnResult.failoverMeta,
          );
          // Terminal bar for this turn, rendered from the turn-start stats
          // snapshot (sequence, compactions, context window fill).
          const terminalBar =
            statsAtTurnStart === undefined
              ? undefined
              : renderStatusBarTerminalLine(statsAtTurnStart);
          if (surfaceStreamPusher && surfaceStreamHandle) {
            await surfaceStreamPusher.flush();
            if (terminalBar && surfaceStreamHandle.setStatusBar) {
              await surfaceStreamHandle.setStatusBar(terminalBar);
            }
            await surfaceStreamHandle.setFullContent(fullBody);
            // Stream edits can't carry file attachments — send as follow-up.
            const attachments = turnResult.showAttachments;
            if (attachments?.length) {
              await adapter.sendBody(sid, "", { attachments: [...attachments] });
            }
          } else {
            await adapter.sendBody(sid, terminalBar ? `${fullBody}\n\n${terminalBar}` : fullBody, {
              replyTo: delivery.replyToMessageId,
            });
          }
        });
        return;
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

      opts.logger.debug("platform.executeTurn_calling", {
        sessionId: sid,
        delivery: input.delivery.kind,
      });
      const internalStreamModel =
        (opts.configRef?.current ?? opts.config).agents?.internalStreaming !== false;
      turnResult = await executeTurn(internalAfterHitlQueued, {
        streamModel: internalStreamModel,
      });
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
    subscribeSubagentSession,
    announcePersistentSubagentSessionEnded,
    handleReactionPassthrough,
    pinMessage: async (input: { readonly channelId: string; readonly messageId: string }) => {
      await opts.discord.discordRestTransport.pinMessage?.(input.channelId, input.messageId);
    },
    adapter,
  };
}
