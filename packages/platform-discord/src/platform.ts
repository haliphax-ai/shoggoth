import type Database from "better-sqlite3";
import type { ModelInvocationParams } from "@shoggoth/models";
import {
  DEFAULT_HITL_CONFIG,
  formatAgentIdentityPrefix,
  type ShoggothConfig,
  type SystemContext,
} from "@shoggoth/shared";
import {
  createHitlPendingResolutionStack,
  createPolicyEngine,
  createYoloModeStore,
  createSessionStore,
  createTranscriptStore,
  createToolRunStore,
  createSessionMcpRuntime,
  defaultPlatformAssistantDeps,
  getTurnQueue,
  PresentationTurnOrchestrator,
  type TieredTurnQueue,
  type PolicyEngine,
  type SessionAgentTurnResult,
  type SessionModelTurnDelivery,
  type OobTurnBannerHandle,
  type PlatformAssistantDeps,
  type HitlConfigRef,
  daemonNotice,
} from "@shoggoth/daemon/lib";
import type {
  HitlNotifier,
  PendingActionRow,
  Logger,
  NoticeResolver,
  DaemonPendingActionsStack,
} from "./daemon-types";
import { statusBarSourceVersions } from "@shoggoth/daemon/lib";
import type { HitlAutoApproveGate } from "@shoggoth/shared";
import type { PendingActionsStore } from "@shoggoth/daemon/lib";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { notice } from "./notices";
import type { DiscordMessagingRuntime } from "./bridge";
import { mergeOrchestratorEnv } from "./config";
import { createDiscordHitlNotifier } from "./hitl/notifier";
import { sliceDiscordPlatformMessageBody } from "./errors";
import { DiscordPlatformAdapter } from "./discord-platform-adapter";
import { resolveStatusBarConfig } from "@shoggoth/shared";
import type { CruiseControlHandle } from "@shoggoth/shared";
import {
  buildStatusBarDep,
  sendHitlQueuedNotice,
  type HitlQueuedDelivery,
} from "./platform-shared";
import {
  handleReactionPassthrough,
  type DiscordReactionPassthroughEvent,
} from "./reaction-passthrough";
import { createOobTurnBanner } from "./oob-banner";
import {
  createSurfaceTurnState,
  runSurfaceTurn,
  type SurfaceTurnDeps,
  type SurfaceTurnInput,
} from "./surface-turn";
import { createInboundTurnPipeline, type InboundTurnPipeline } from "./inbound-turn";

// Keep platform.ts's prior exports working: buildStatusBarDep was exported from
// platform.ts before the split and is now implemented in platform-shared.
export { buildStatusBarDep };

/** Notice resolution for this platform instance: opts.noticeResolver if set. */
function platformNoticeResolver(opts: DiscordPlatformOptions): NoticeResolver {
  return opts.noticeResolver ?? daemonNotice;
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
  readonly hitlPending?: DaemonPendingActionsStack;
  readonly logger: Logger;
  readonly discord: DiscordMessagingRuntime;
  readonly configRef?: { current: ShoggothConfig };
  readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
  /** Cruise control (HITL auto-pilot): per-session store + judge. */
  readonly cruiseControl?: CruiseControlHandle;
  /** Daemon's notice resolver for this platform instance; falls back to the daemon module global. */
  readonly noticeResolver?: NoticeResolver;
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
    /** Operator-facing banner spliced into this turn's output before the model's prose. */
    readonly turnBanner?: string;
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
  const yoloMode = createYoloModeStore(opts.db);
  // Last-read yolo state per session, keyed alongside yoloVersionAtLastRead.
  const yoloReadCache = new Map<string, boolean>();
  // The daemon-supplied store carries the full resolution surface; the platform
  // only depends on the minimal view above. Adapter to the tool-loop contract so
  // a daemon-side removal of a resolution method fails the typecheck here.
  const pendingForToolLoop = pending as unknown as PendingActionsStore;

  // A state DB that has not run the yolo migration yet must not break a turn:
  // the flag simply reads as off. The provider re-reads only on a version
  // change (pure cache between changes — no steady-state SQLite access).
  const yoloVersionAtLastRead = new Map<string, number>();
  const yoloActive = (sessionId: string): boolean => {
    const version = statusBarSourceVersions().yolo;
    if (yoloVersionAtLastRead.get(sessionId) === version) {
      return yoloReadCache.get(sessionId) ?? false;
    }
    let enabled = false;
    try {
      enabled = yoloMode.isEnabled(sessionId);
    } catch {
      enabled = false;
    }
    yoloReadCache.set(sessionId, enabled);
    yoloVersionAtLastRead.set(sessionId, version);
    return enabled;
  };

  /** Live cruise-control activity provider for status-bar trackers. */
  const cruiseControlActiveFor = (sessionId: string): boolean => {
    const provider = cruiseStatusBarProvider(opts, sessionId).cruiseControlActive;
    return provider ? provider() : false;
  };

  const assistantDeps = pickDiscordAssistantDeps(opts.deps);
  const noticeResolver = platformNoticeResolver(opts);
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
    cruiseControlActiveFor,
    (sessionId) => yoloActive(sessionId),
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

  /** Shared deps for the in-session HITL queued-notice delivery. */
  const sharedNoticeDeps = {
    discord: opts.discord,
    hitlDiscordNoticeRegistry: opts.hitlDiscordNoticeRegistry,
    logger: opts.logger,
  };

  /** Send the in-session HITL queued notice and wire up approval reactions. */
  const hitlQueuedNotice = (row: PendingActionRow, delivery: HitlQueuedDelivery): Promise<void> =>
    sendHitlQueuedNotice(sharedNoticeDeps, row, delivery);

  // Inbound turn pipeline: chained dispatch, segment commands, and the queued
  // inbound model turn — extracted to inbound-turn.ts; this wires the
  // platform's stores, HITL stack, MCP runtime, and orchestrator into it.
  const inbound: InboundTurnPipeline = createInboundTurnPipeline({
    db: opts.db,
    config: opts.config,
    configRef: opts.configRef,
    env,
    logger: opts.logger,
    sessions,
    transcript,
    toolRuns,
    turnQueue,
    mcpRuntime,
    policyEngine: engine,
    getHitlConfig,
    pendingForToolLoop,
    waitForHitlResolution,
    hitlNotifier,
    hitlAutoApproveGate: opts.hitlAutoApproveGate,
    loopImpl,
    createToolCallingClient: createToolClient,
    cruiseControlToolLoopHook: () => cruiseControlToolLoopHook(opts),
    yoloActive,
    adapter,
    orchestrator,
    statusBarDep,
    hitlQueuedNotice,
    noticeResolver,
    discord: opts.discord,
    configForOwnerGate,
  });

  const unsubs = opts.discord.routes.map((route) =>
    opts.discord.bus.subscribe(route.sessionId, (msg) => {
      void inbound.dispatchChained(route.sessionId, msg).catch((e) => {
        opts.logger.error("discord.platform.dispatch_failed", {
          err: String(e),
        });
      });
    }),
  );

  // Surface turn engine wiring: everything the engine needs, captured once —
  // the engine itself owns no platform closures. The per-turn presentation
  // state is built fresh for each call (see createSurfaceTurnState).
  const surfaceTurnDeps: SurfaceTurnDeps = {
    db: opts.db,
    config: opts.config,
    configRef: opts.configRef,
    env,
    logger: opts.logger,
    sessions,
    transcript,
    toolRuns,
    turnQueue,
    resolveMcpContext: mcpRuntime.resolveContext,
    policyEngine: engine,
    getHitlConfig,
    pendingForToolLoop,
    waitForHitlResolution,
    hitlNotifier,
    hitlAutoApproveGate: opts.hitlAutoApproveGate,
    loopImpl,
    createToolCallingClient: createToolClient,
    cruiseControlToolLoopHook: () => cruiseControlToolLoopHook(opts),
    yoloActive,
    cruiseControlActiveFor,
    yoloModeActive: (sessionId) => yoloActive(sessionId),
    adapter,
    streamingForSession: opts.discord.streamingForSession,
    statusBarDep,
    hitlQueuedNotice,
    configForOwnerGate,
    resolveOutboundChannelIdForSession: opts.discord.resolveOutboundChannelIdForSession,
    streamMinMs,
  };

  async function runSessionModelTurn(input: SurfaceTurnInput): Promise<SessionAgentTurnResult> {
    return runSurfaceTurn(surfaceTurnDeps, createSurfaceTurnState(input.turnBanner), input);
  }

  function subscribeSubagentSession(sessionId: string): () => void {
    const sid = sessionId.trim();
    const u = opts.discord.bus.subscribe(sid, (msg) => {
      void inbound.dispatchChained(sid, msg).catch((e) => {
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
        ? notice(noticeResolver, "subagent-persistent-ended-ttl")
        : notice(noticeResolver, "subagent-persistent-ended-killed");
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
  /** Reaction passthrough — extracted to reaction-passthrough.ts; this wires
   *  the platform's live config reference and turn entry into the deps. */
  const reactionPassthrough = (ev: DiscordReactionPassthroughEvent): Promise<void> =>
    handleReactionPassthrough(
      {
        config: opts.config,
        configRef: opts.configRef,
        logger: opts.logger,
        runSessionModelTurn: (input) => runSessionModelTurn(input),
      },
      ev,
    );

  /** OOB turn banner surface — extracted to oob-banner.ts; wired with the
   *  platform's streaming outbound resolver and logger. */
  const oobTurnBanner = createOobTurnBanner({
    logger: opts.logger,
    streamingForSession: opts.discord.streamingForSession,
  });

  return {
    stop: async () => {
      for (const u of unsubs) u();
      for (const u of subagentBusUnsubs) u();
      subagentBusUnsubs.length = 0;
      await inbound.stop();
      await mcpRuntime.shutdown();
    },
    runSessionModelTurn,
    oobTurnBanner,
    subscribeSubagentSession,
    announcePersistentSubagentSessionEnded,
    handleReactionPassthrough: reactionPassthrough,
    pinMessage: async (input: { readonly channelId: string; readonly messageId: string }) => {
      await opts.discord.discordRestTransport.pinMessage?.(input.channelId, input.messageId);
    },
    adapter,
  };
}
