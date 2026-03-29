import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  createOutboundMessage,
  type DiscordStreamHandle,
  type InternalMessage,
} from "@shoggoth/messaging";
import {
  DEFAULT_HITL_CONFIG,
  type ShoggothConfig,
} from "@shoggoth/shared";
import type { HitlNotifier } from "../hitl/hitl-notifier";
import { createHitlPendingResolutionStack, type HitlPendingStack } from "../hitl/hitl-pending-stack";
import type { Logger } from "../logging";
import { createPolicyEngine, type PolicyEngine } from "../policy/engine";
import type { HitlConfigRef } from "../config-hot-reload";
import { mergeOrchestratorEnv } from "../config/effective-runtime";
import { executeSessionAgentTurn } from "../sessions/session-agent-turn";
import {
  defaultDiscordAssistantDeps,
  type DiscordPlatformAssistantDeps,
} from "../sessions/assistant-runtime";
import { createSessionStore } from "../sessions/session-store";
import { createTranscriptStore } from "../sessions/transcript-store";
import { createToolRunStore } from "../sessions/tool-run-store";
import { createSessionMcpRuntime } from "../sessions/session-mcp-runtime";
import { buildSessionSystemContext } from "../sessions/session-system-prompt";
import type { SessionToolLoopFailoverState } from "../sessions/session-tool-loop-model-client";
import type { DiscordMessagingRuntime } from "../messaging/discord-bridge";
import { buildHitlQueuedNoticeLines, createDiscordHitlNotifier } from "./discord-hitl-notifier";
import {
  formatDiscordPlatformErrorUserText,
  sliceDiscordPlatformMessageBody,
} from "./discord-errors";

function pickDiscordAssistantDeps(
  input?: Partial<DiscordPlatformAssistantDeps> & { readonly hitlNotifier?: HitlNotifier },
): DiscordPlatformAssistantDeps {
  if (!input) return defaultDiscordAssistantDeps;
  const { hitlNotifier: _hitlNotifier, ...rest } = input;
  void _hitlNotifier;
  return { ...defaultDiscordAssistantDeps, ...rest };
}

export function formatDiscordPlatformDegradedPrefix(
  meta: SessionToolLoopFailoverState | undefined,
): string {
  if (!meta?.degraded) return "";
  return (
    `⚠️ *Degraded:* backup model \`${meta.usedModel}\` (${meta.usedProviderId}) — primary unavailable.\n\n`
  );
}

/** When `SHOGGOTH_DISCORD_MODEL_TAG=1`, append italic operator footer with last hop model/provider. */
export function formatDiscordPlatformModelTagFooter(
  processEnv: NodeJS.ProcessEnv | undefined,
  meta: SessionToolLoopFailoverState | undefined,
): string {
  const e = processEnv ?? process.env;
  if (e.SHOGGOTH_DISCORD_MODEL_TAG !== "1" || !meta) return "";
  return `\n\n_model: ${meta.usedModel} · provider: ${meta.usedProviderId}_`;
}

/**
 * Coalesces high-frequency model token updates into occasional Discord `editMessage` calls
 * (rate-limit friendly). Always call {@link flush} before the final body patch.
 */
function createStreamEditBatcher(
  setFull: (s: string) => Promise<void>,
  minIntervalMs: number,
): {
  push: (text: string) => void;
  flush: () => Promise<void>;
} {
  let latest = "";
  let lastSent = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  function push(text: string) {
    latest = text;
    const now = Date.now();
    if (minIntervalMs <= 0 || now - lastSent >= minIntervalMs) {
      lastSent = now;
      chain = chain.then(() => setFull(latest)).catch(() => {});
      return;
    }
    if (timeout) clearTimeout(timeout);
    const wait = minIntervalMs - (now - lastSent);
    timeout = setTimeout(() => {
      timeout = undefined;
      lastSent = Date.now();
      chain = chain.then(() => setFull(latest)).catch(() => {});
    }, wait);
  }

  async function flush() {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    await chain;
    lastSent = Date.now();
    await setFull(latest);
  }

  return { push, flush };
}

export interface DiscordPlatformOptions {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  /** When set, used for tool/control authz in the loop (e.g. delegating engine for hot-reload). */
  readonly policyEngine?: PolicyEngine;
  /** When set, HITL block reads this each turn so timeouts/tiers can update without restart. */
  readonly hitlConfigRef?: HitlConfigRef;
  /**
   * Shared pending store + waiters (must match control plane `hitlPending`).
   * When omitted, tests/single-process callers get an isolated stack: control-socket approve/deny will
   * not unblock this platform's `waitForHitlResolution` waiters.
   */
  readonly hitlPending?: HitlPendingStack;
  readonly logger: Logger;
  readonly discord: DiscordMessagingRuntime;
  /**
   * Merged with `process.env` then layered `discord` / `runtime` flags fill empty `SHOGGOTH_*` keys
   * ({@link mergeOrchestratorEnv}). Omit to use only process env + config.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Assistant loop + MCP pool wiring. Production passes {@link defaultDiscordAssistantDeps} from
   * `assistant-runtime`. Tests may override pieces; omit entirely to use the same defaults.
   */
  readonly deps?: Partial<DiscordPlatformAssistantDeps> & {
    readonly hitlNotifier?: HitlNotifier;
  };
}

export interface DiscordPlatformHandle {
  /** Unsubscribe from Discord routes and close MCP subprocesses/sockets when configured. */
  readonly stop: () => Promise<void>;
}

/**
 * Subscribes to the Discord A2A bus, forwards inbound text to the core session agent turn
 * (transcript, MCP pools, tool loop), and delivers replies via Discord REST/streaming.
 */
export async function startDiscordPlatform(
  opts: DiscordPlatformOptions,
): Promise<DiscordPlatformHandle> {
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
    createDiscordHitlNotifier({ logger: opts.logger, env, discord: opts.discord });

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
        hint: "no SQLite session row for this route; run scripts/bootstrap-main-session.mjs inside the container (or your session bootstrap) after empty state",
      });
      return;
    }

    if (mcpRuntime.trackPerSessionIdle) {
      mcpRuntime.notifyTurnBegin(msg.sessionId);
    }

    const hitlReplyInSession = env.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION !== "0";
    const streamEnabled = env.SHOGGOTH_DISCORD_STREAM === "1";
    const streamingOutbound = streamEnabled ? opts.discord.streamingForSession(msg.sessionId) : undefined;
    let streamHandle: DiscordStreamHandle | undefined;
    let streamPusher: ReturnType<typeof createStreamEditBatcher> | undefined;
    if (streamingOutbound) {
      try {
        streamHandle = await streamingOutbound.start();
        const rawMin = Number(env.SHOGGOTH_DISCORD_STREAM_MIN_MS ?? 400);
        const minMs = Number.isFinite(rawMin) ? Math.max(0, rawMin) : 400;
        const h = streamHandle;
        streamPusher = createStreamEditBatcher((s) => h.setFullContent(s), minMs);
      } catch (e) {
        opts.logger.warn("discord.platform.stream_start_failed", { err: String(e) });
        streamHandle = undefined;
        streamPusher = undefined;
      }
    }

    try {
      const mcpCtx = await mcpRuntime.resolveContext(msg.sessionId);
      const turn = await executeSessionAgentTurn({
        db: opts.db,
        sessionId: msg.sessionId,
        session,
        transcript,
        toolRuns,
        userContent: msg.body,
        userMetadata: { discordMessageId: msg.id },
        systemPrompt: buildSessionSystemContext({
          workspacePath: session.workspacePath,
          config: opts.config,
          env,
          sessionId: session.id,
          channel: "discord",
          toolNames: mcpCtx.toolsOpenAi.map((t) => t.function.name),
          sandbox: { runtimeUid: session.runtimeUid, runtimeGid: session.runtimeGid },
        }),
        env,
        config: opts.config,
        policyEngine: engine,
        getHitlConfig,
        hitl: {
          principalRoles: [],
          pending,
          clock: { nowMs: () => Date.now() },
          newPendingId: () => randomUUID(),
          waitForHitlResolution,
          hitlNotifier,
          ...(hitlReplyInSession
            ? {
                afterHitlQueued: async (row) => {
                  await opts.discord.outbound.sendDiscord(
                    createOutboundMessage({
                      id: randomUUID(),
                      sessionId: msg.sessionId,
                      userId: msg.userId,
                      createdAt: new Date().toISOString(),
                      body: sliceDiscordPlatformMessageBody(buildHitlQueuedNoticeLines(row).join("\n")),
                      extensions: { replyToMessageId: msg.id },
                    }),
                  );
                },
              }
            : {}),
        },
        loopImpl,
        createToolCallingClient: createToolClient,
        resolveMcpContext: mcpRuntime.resolveContext,
        stream: streamPusher
          ? {
              streamModel: true,
              onModelTextDelta: (t) => {
                const vis = t.trim() ? t : "…";
                streamPusher!.push(sliceDiscordPlatformMessageBody(vis));
              },
            }
          : undefined,
      });

      const banner = formatDiscordPlatformDegradedPrefix(turn.failoverMeta);
      const modelTag = formatDiscordPlatformModelTagFooter(env, turn.failoverMeta);
      const body = sliceDiscordPlatformMessageBody(`${banner}${turn.latestAssistantText}${modelTag}`);

      if (streamPusher && streamHandle) {
        await streamPusher.flush();
        await streamHandle.setFullContent(body);
      } else {
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
      }
    } catch (e) {
      const errBody = sliceDiscordPlatformMessageBody(`⚠️ ${formatDiscordPlatformErrorUserText(e)}`);
      opts.logger.warn("discord.platform.turn_failed", { err: String(e), sessionId: msg.sessionId });
      try {
        await opts.discord.outbound.sendDiscord(
          createOutboundMessage({
            id: randomUUID(),
            sessionId: msg.sessionId,
            userId: msg.userId,
            createdAt: new Date().toISOString(),
            body: errBody,
            extensions: { replyToMessageId: msg.id },
          }),
        );
      } catch (sendErr) {
        opts.logger.error("discord.platform.error_reply_failed", { err: String(sendErr) });
      }
    } finally {
      if (mcpRuntime.trackPerSessionIdle) {
        mcpRuntime.notifyTurnEnd(msg.sessionId);
      }
    }
  }

  return {
    stop: async () => {
      for (const u of unsubs) u();
      const inFlightChains = [...chainTail.values()];
      chainTail.clear();
      await Promise.all(inFlightChains);
      await mcpRuntime.shutdown();
    },
  };
}
