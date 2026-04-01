import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createOutboundMessage,
  MESSAGING_FEATURE,
  messagingCapabilitiesHasFeature,
  type InternalMessage,
} from "@shoggoth/messaging";
import {
  DEFAULT_HITL_CONFIG,
  formatAgentIdentityPrefix,
  parseAgentSessionUrn,
  type ShoggothConfig,
} from "@shoggoth/shared";
import {
  createHitlPendingResolutionStack,
  createPolicyEngine,
  createSessionStore,
  createTranscriptStore,
  createToolRunStore,
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
  parseSessionSegmentInlineCommand,
  sessionSegmentStartupUserContent,
  resolveSessionAgentHitlPrincipalRoles,
  runInboundSessionTurn,
  executeSessionAgentTurn,
  buildSessionSystemContext,
  createSessionMcpRuntime,
  defaultPlatformAssistantDeps,
  type HitlPendingStack,
  type PolicyEngine,
  type HitlConfigRef,
  type SessionAgentTurnResult,
  type SessionToolLoopFailoverState,
  type SessionModelTurnDelivery,
  type PlatformAssistantDeps,
} from "@shoggoth/daemon/lib";
import type { HitlNotifier, PendingActionRow, Logger, HitlAutoApproveGate } from "./daemon-types";
import { daemonNotice } from "./notices";
import type { DiscordMessagingRuntime } from "./bridge";
import type { DiscordStreamHandle } from "./streaming";
import { mergeOrchestratorEnv, resolveDiscordOwnerUserId } from "./config";
import { registerDiscordHitlNoticeAndAddReactions } from "./hitl/reaction-wiring";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { buildHitlQueuedNoticeLines, createDiscordHitlNotifier } from "./hitl/notifier";
import {
  formatDiscordPlatformErrorUserText,
  sliceDiscordPlatformMessageBody,
} from "./errors";

/** Discord typing indicator lasts ~10s; renew while the model formulates a reply. */
const DISCORD_TYPING_RENEWAL_MS = 8000;

async function withAgentTypingWhile(
  discord: DiscordPlatformOptions["discord"],
  sessionId: string,
  work: () => Promise<void>,
): Promise<void> {
  if (!messagingCapabilitiesHasFeature(discord.capabilities, MESSAGING_FEATURE.TYPING_NOTIFICATION)) {
    await work();
    return;
  }
  await discord.notifyAgentTypingForSession(sessionId);
  const id = setInterval(() => {
    void discord.notifyAgentTypingForSession(sessionId);
  }, DISCORD_TYPING_RENEWAL_MS);
  try {
    await work();
  } finally {
    clearInterval(id);
  }
}

function pickDiscordAssistantDeps(
  input?: Partial<PlatformAssistantDeps> & { readonly hitlNotifier?: HitlNotifier },
): PlatformAssistantDeps {
  if (!input) return defaultPlatformAssistantDeps;
  const { hitlNotifier: _hitlNotifier, ...rest } = input;
  void _hitlNotifier;
  return { ...defaultPlatformAssistantDeps, ...rest };
}

export function formatDiscordPlatformDegradedPrefix(
  meta: SessionToolLoopFailoverState | undefined,
): string {
  if (!meta?.degraded) return "";
  return `${daemonNotice("degraded-banner", {
    usedModel: meta.usedModel,
    usedProviderId: meta.usedProviderId,
  })}\n\n`;
}

/** When `SHOGGOTH_DISCORD_MODEL_TAG=1`, append italic operator footer with last hop model/provider. */
export function formatDiscordPlatformModelTagFooter(
  processEnv: NodeJS.ProcessEnv | undefined,
  meta: SessionToolLoopFailoverState | undefined,
): string {
  const e = processEnv ?? process.env;
  if (e.SHOGGOTH_DISCORD_MODEL_TAG !== "1" || !meta) return "";
  return `\n\n${daemonNotice("model-tag-footer", {
    usedModel: meta.usedModel,
    usedProviderId: meta.usedProviderId,
  })}`;
}

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
    readonly delivery: SessionModelTurnDelivery;
  }) => Promise<SessionAgentTurnResult>;
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  readonly announcePersistentSubagentSessionEnded: (input: {
    readonly sessionId: string;
    readonly reason: "ttl_expired" | "killed";
  }) => void;
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

  const engine = opts.policyEngine ?? createPolicyEngine(opts.config.policy);
  const getHitlConfig = (): ShoggothConfig["hitl"] =>
    opts.hitlConfigRef
      ? opts.hitlConfigRef.value
      : { ...DEFAULT_HITL_CONFIG, ...opts.config.hitl };

  const mcpRuntime = await createSessionMcpRuntime({
    config: opts.config,
    logger: opts.logger,
    env,
    deps: { connectShoggothMcpServers: assistantDeps.connectShoggothMcpServers },
  });

  const loopImpl = assistantDeps.runToolLoopImpl;
  const createToolClient = assistantDeps.createToolCallingClient;

  const chainTail = new Map<string, Promise<void>>();
  const subagentBusUnsubs: (() => void)[] = [];

  const unsubs = opts.discord.routes.map((route) =>
    opts.discord.bus.subscribe(route.sessionId, (msg) => {
      void dispatchChained(route.sessionId, msg).catch((e) => {
        opts.logger.error("discord.platform.dispatch_failed", { err: String(e) });
      });
    }),
  );

  async function dispatchChained(sessionId: string, msg: InternalMessage): Promise<void> {
    const prev = chainTail.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => handleInbound(msg));
    chainTail.set(sessionId, run.catch(() => {}));
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
                daemonNotice("segment-command-error", { mode: segmentMode, error: String(e) }),
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
        opts.logger.warn("discord.platform.segment_ack_failed", { err: String(e) });
      }
      await runDiscordInboundModelTurn(msg, sessionAfter, sessionSegmentStartupUserContent(segmentMode), {
        sessionSegmentStartup: segmentMode,
      });
      return;
    }

    await runDiscordInboundModelTurn(msg, session, msg.body, {});
  }

  async function runDiscordInboundModelTurn(
    msg: InternalMessage,
    session: NonNullable<ReturnType<typeof sessions.getById>>,
    userContent: string,
    extraUserMetadata: Record<string, unknown>,
  ): Promise<void> {
    const hitlReplyInSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";
    const streamEnabled = env.SHOGGOTH_DISCORD_STREAM === "1";
    const streamingOutbound = streamEnabled ? opts.discord.streamingForSession(msg.sessionId) : undefined;
    const rawStreamMin = Number(env.SHOGGOTH_DISCORD_STREAM_MIN_MS ?? 400);
    const streamMinMs = Number.isFinite(rawStreamMin) ? Math.max(0, rawStreamMin) : 400;

    const mcpLifecycle =
      mcpRuntime.trackPerSessionIdle
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
    // posting the placeholder inside withAgentTypingWhile would kill the indicator.
    let preStartedStreamHandle: DiscordStreamHandle | undefined;
    if (streamingOutbound) {
      try {
        preStartedStreamHandle = await streamingOutbound.start();
      } catch (e) {
        opts.logger.warn("discord.platform.stream_start_failed", { err: String(e) });
      }
    }

    await withAgentTypingWhile(opts.discord, msg.sessionId, async () => {
      await runInboundSessionTurn({
        logger: opts.logger,
        logContext: { sessionId: msg.sessionId },
        mcpLifecycle,
        streaming:
          preStartedStreamHandle !== undefined
            ? {
                minIntervalMs: streamMinMs,
                start: () => Promise.resolve(preStartedStreamHandle!),
                onStartFailed: (errMsg) => {
                  opts.logger.warn("discord.platform.stream_start_failed", { err: errMsg });
                },
              }
            : undefined,
        sliceDisplayText: sliceDiscordPlatformMessageBody,
        formatAssistantReply: (latest, meta) => {
          const cfg = opts.configRef?.current ?? opts.config;
          return `${formatDiscordPlatformDegradedPrefix(meta)}${formatAgentIdentityPrefix(cfg, msg.sessionId)}${latest}${formatDiscordPlatformModelTagFooter(env, meta)}`;
        },
        formatErrorReply: (e) => `⚠️ ${formatDiscordPlatformErrorUserText(e)}`,
        onTurnExecutionFailed: (e) => {
          opts.logger.warn("discord.platform.turn_failed", { err: String(e), sessionId: msg.sessionId });
        },
        sendAssistantBody: async (body) => {
          await opts.discord.outbound.sendDiscord(
            createOutboundMessage({
              id: randomUUID(),
              sessionId: msg.sessionId,
              userId: msg.userId,
              createdAt: new Date().toISOString(),
              body,
              extensions: { replyToMessageId: msg.id },
            }),
          );
        },
        sendErrorBody: async (body) => {
          try {
            await opts.discord.outbound.sendDiscord(
              createOutboundMessage({
                id: randomUUID(),
                sessionId: msg.sessionId,
                userId: msg.userId,
                createdAt: new Date().toISOString(),
                body,
                extensions: { replyToMessageId: msg.id },
              }),
            );
          } catch (sendErr) {
            opts.logger.error("discord.platform.error_reply_failed", { err: String(sendErr) });
          }
        },
        buildTurn: async () => {
          const mcpCtx = await mcpRuntime.resolveContext(msg.sessionId);
          return {
            db: opts.db,
            sessionId: msg.sessionId,
            session,
            transcript,
            toolRuns,
            userContent,
            userMetadata,
            systemPrompt: buildSessionSystemContext({
              workspacePath: session.workspacePath,
              config: opts.config,
              env,
              sessionId: session.id,
              contextSegmentId: session.contextSegmentId,
              channel: parseAgentSessionUrn(session.id)?.platform,
              messagingCapabilities: opts.discord.capabilities,
              toolNames: mcpCtx.toolsOpenAi.map((t) => t.function.name),
              sandbox: { runtimeUid: session.runtimeUid, runtimeGid: session.runtimeGid },
              stateDb: opts.db,
              transcriptMessages: (opts.db.prepare(
                `SELECT role, content FROM transcript_messages
                 WHERE session_id = ? AND context_segment_id = ? ORDER BY seq`,
              ).all(session.id, session.contextSegmentId) as { role: string; content: string | null }[]),
            }),
            env,
            config: opts.config,
            policyEngine: engine,
            getHitlConfig,
            hitl: {
              principalRoles: resolveSessionAgentHitlPrincipalRoles(msg.sessionId),
              pending,
              clock: { nowMs: () => Date.now() },
              newPendingId: () => randomUUID(),
              waitForHitlResolution,
              hitlNotifier,
              autoApprove: opts.hitlAutoApproveGate,
              ...(hitlReplyInSession
                ? {
                    afterHitlQueued: async (row) => {
                      const ref = await opts.discord.outbound.sendDiscord(
                        createOutboundMessage({
                          id: randomUUID(),
                          sessionId: msg.sessionId,
                          userId: msg.userId,
                          createdAt: new Date().toISOString(),
                          body: sliceDiscordPlatformMessageBody(buildHitlQueuedNoticeLines(row).join("\n")),
                          extensions: { replyToMessageId: msg.id },
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
                    },
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
  }

  async function runSessionModelTurn(input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly delivery: SessionModelTurnDelivery;
  }): Promise<SessionAgentTurnResult> {
    const sid = input.sessionId.trim();
    const sessionRow = sessions.getById(sid);
    if (!sessionRow || sessionRow.status === "terminated") {
      throw new Error(`session not available: ${sid}`);
    }
    const mcpCtx = await mcpRuntime.resolveContext(sid);
    const userMetadata = input.userMetadata ?? {};
    const hitlReplyInSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";
    const buildAfterHitlQueued = (delivery: { readonly userId: string; readonly replyToMessageId?: string }) =>
      hitlReplyInSession
        ? async (row: PendingActionRow) => {
            const ref = await opts.discord.outbound.sendDiscord(
              createOutboundMessage({
                id: randomUUID(),
                sessionId: sid,
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
        : undefined;

    const executeTurn = (afterHitlQueued?: (row: PendingActionRow) => void | Promise<void>) =>
      executeSessionAgentTurn({
        db: opts.db,
        sessionId: sid,
        session: sessionRow,
        transcript,
        toolRuns,
        userContent: input.userContent,
        userMetadata,
        systemPrompt: buildSessionSystemContext({
          workspacePath: sessionRow.workspacePath,
          config: opts.config,
          env,
          sessionId: sessionRow.id,
          contextSegmentId: sessionRow.contextSegmentId,
          channel: parseAgentSessionUrn(sessionRow.id)?.platform,
          messagingCapabilities: opts.discord.capabilities,
          toolNames: mcpCtx.toolsOpenAi.map((t) => t.function.name),
          sandbox: { runtimeUid: sessionRow.runtimeUid, runtimeGid: sessionRow.runtimeGid },
          stateDb: opts.db,
          transcriptMessages: (opts.db.prepare(
            `SELECT role, content FROM transcript_messages
             WHERE session_id = ? AND context_segment_id = ? ORDER BY seq`,
          ).all(sessionRow.id, sessionRow.contextSegmentId) as { role: string; content: string | null }[]),
        }),
        env,
        config: opts.config,
        policyEngine: engine,
        getHitlConfig,
        hitl: {
          principalRoles: resolveSessionAgentHitlPrincipalRoles(sid),
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
      });

    if (input.delivery.kind === "messaging_surface") {
      const delivery = input.delivery;
      let turnResult!: SessionAgentTurnResult;
      await withAgentTypingWhile(opts.discord, sid, async () => {
        turnResult = await executeTurn(buildAfterHitlQueued(delivery));
        const cfg = opts.configRef?.current ?? opts.config;
        const body = sliceDiscordPlatformMessageBody(
          `${formatDiscordPlatformDegradedPrefix(turnResult.failoverMeta)}${formatAgentIdentityPrefix(cfg, sid)}${turnResult.latestAssistantText}${formatDiscordPlatformModelTagFooter(env, turnResult.failoverMeta)}`,
        );
        await opts.discord.outbound.sendDiscord(
          createOutboundMessage({
            id: randomUUID(),
            sessionId: sid,
            userId: delivery.userId,
            createdAt: new Date().toISOString(),
            body,
            extensions: {
              replyToMessageId: delivery.replyToMessageId,
            },
          }),
        );
      });
      return turnResult;
    }

    // Internal delivery (e.g. one-shot subagents): resolve parent session's channel for HITL notices
    let internalAfterHitlQueued: ((row: PendingActionRow) => void | Promise<void>) | undefined;
    if (sessionRow.parentSessionId && hitlReplyInSession) {
      const parentRow = sessions.getById(sessionRow.parentSessionId);
      const parentChannelId = parentRow
        ? opts.discord.resolveOutboundChannelIdForSession?.(parentRow.id)
        : undefined;
      if (parentChannelId) {
        const ownerUserId = resolveDiscordOwnerUserId(configForOwnerGate());
        internalAfterHitlQueued = async (row: PendingActionRow) => {
          const ref = await opts.discord.outbound.sendDiscord(
            createOutboundMessage({
              id: randomUUID(),
              sessionId: sessionRow.parentSessionId!,
              userId: ownerUserId ?? "system",
              createdAt: new Date().toISOString(),
              body: sliceDiscordPlatformMessageBody(buildHitlQueuedNoticeLines(row).join("\n")),
              extensions: {},
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
        };
      }
    }

    return await executeTurn(internalAfterHitlQueued);
  }

  function subscribeSubagentSession(sessionId: string): () => void {
    const sid = sessionId.trim();
    const u = opts.discord.bus.subscribe(sid, (msg) => {
      void dispatchChained(sid, msg).catch((e) => {
        opts.logger.error("discord.platform.dispatch_failed", { err: String(e) });
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
    void opts.discord.discordRestTransport
      .createMessage(threadId, { content: body })
      .catch((e) => {
        opts.logger.debug("discord.subagent.persistent_end_notice_failed", {
          sessionId: input.sessionId,
          err: String(e),
        });
      });
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
  };
}
