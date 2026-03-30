import {
  DEFAULT_HITL_CONFIG,
  loadLayeredConfig,
  LAYOUT,
  VERSION,
} from "@shoggoth/shared";
import { fileURLToPath } from "node:url";
import { migrate, defaultMigrationsDir } from "./db/migrate";
import { openStateDb } from "./db/open";
import { runCronTick } from "./events/cron-scheduler";
import { runBootReconciliation } from "./events/boot-reconciliation";
import { runRetentionJobs, retentionScheduleIntervalMs } from "./retention/retention-jobs";
import {
  runTranscriptAutoCompactTick,
  transcriptAutoCompactIntervalMs,
} from "./transcript-auto-compact";
import {
  createDefaultHeartbeatHandlers,
  runHeartbeatBatch,
} from "./events/heartbeat-consumer";
import {
  createSqliteProbe,
  createDiscordProbe,
  createModelEndpointProbe,
} from "./health";
import { startConfigHotReload } from "./config-hot-reload";
import {
  isConfigHotReloadEnabled,
  resolveBootStaleClaimMs,
  resolveCronTickIntervalMs,
  resolveDiscordOwnerUserId,
  resolveDrainTimeoutMs,
  resolveHeartbeatBatchSize,
  resolveHeartbeatConcurrency,
  resolveHeartbeatIntervalMs,
  resolveModelHealthProbeBaseUrl,
} from "./config/effective-runtime";
import { startControlPlane } from "./control/control-plane";
import { createLogger } from "./logging";
import { createDelegatingPolicyEngine, createPolicyEngine } from "./policy/engine";
import { bootstrapPlugins } from "./plugins/bootstrap";
import { createDaemonRuntime } from "./runtime";
import { createToolRunStore } from "./sessions/tool-run-store";
import { startDiscordPlatform } from "./platforms/discord";
import { reconcilePersistentBoundSubagents } from "./subagent/reconcile-persistent-bound-subagents";
import {
  messageToolContextRef,
  messageToolSliceFromCapabilities,
} from "./messaging/message-tool-context-ref";
import { setSubagentRuntimeExtension } from "./subagent/subagent-extension-ref";
import { defaultDiscordAssistantDeps } from "./sessions/assistant-runtime";
import { createPersistingHitlAutoApproveGate } from "./hitl/hitl-auto-approve-persisting";
import { type HitlAutoApproveGate } from "./hitl/hitl-auto-approve";
import {
  createHitlDiscordNoticeRegistry,
  type HitlDiscordNoticeRegistry,
} from "./hitl/hitl-discord-notice-registry";
import { handleDiscordHitlReactionAdd } from "./hitl/discord-hitl-reaction-handler";
import { createHitlPendingResolutionStack, type HitlPendingStack } from "./hitl/hitl-pending-stack";
import { registerBuiltInMessagingPlatforms } from "@shoggoth/messaging";
import {
  startDaemonDiscordMessaging,
  type DiscordMessagingRuntime,
} from "./messaging/daemon-messaging-bootstrap";
import { executeDiscordMessageToolAction } from "@shoggoth/messaging";
import { loadDaemonNotices } from "./notices/load-notices";
import { loadDaemonPrompts } from "./prompts/load-prompts";

loadDaemonPrompts();
loadDaemonNotices();
registerBuiltInMessagingPlatforms();

const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
const config = loadLayeredConfig(configDir);

const configRef = { current: config };

/** Env `DISCORD_BOT_TOKEN` overrides layered `discord.botToken` (hot-reload picks up config changes). */
function resolvedDiscordBotToken(): string | undefined {
  const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return configRef.current.discord?.botToken?.trim() || undefined;
}
const policyRef = { engine: createPolicyEngine(config.policy) };
const policyEngine = createDelegatingPolicyEngine(() => policyRef.engine);
const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...config.hitl } };

const interruptLog = createLogger({
  component: "shoggoth-daemon",
  minLevel: config.logLevel,
  baseFields: { subsystem: "lifecycle" },
});

const drainTimeoutMs = resolveDrainTimeoutMs(config);

/** Set after state DB opens; used on shutdown to fail in-flight tool runs before close. */
const stateShutdown: {
  db: ReturnType<typeof openStateDb> | undefined;
  toolRuns: ReturnType<typeof createToolRunStore> | undefined;
} = { db: undefined, toolRuns: undefined };

let stopEventLoops: () => void = () => {};
let discordMessaging: DiscordMessagingRuntime | undefined;

const rt = createDaemonRuntime({
  component: "shoggoth-daemon",
  logLevel: config.logLevel,
  shutdown: {
    drainTimeoutMs,
    async onStopAccepting() {
      interruptLog.info("stop accepting new work");
    },
    async markInterruptedRunsFailed(reason: string) {
      try {
        const tr = stateShutdown.toolRuns;
        if (tr) {
          const n = tr.markAllRunningFailed(reason);
          interruptLog.info("interrupted tool runs marked failed", { reason, count: n });
        }
      } catch (e) {
        interruptLog.error("mark interrupted tool runs failed", { err: String(e) });
      } finally {
        try {
          stateShutdown.db?.close();
        } catch {
          /* ignore */
        }
        stateShutdown.db = undefined;
        stateShutdown.toolRuns = undefined;
      }
    },
  },
});

void (async () => {
  let stateDb: ReturnType<typeof openStateDb> | undefined;
  let hitlStack: HitlPendingStack | undefined;
  try {
    const db = openStateDb(config.stateDbPath);
    migrate(db, defaultMigrationsDir());
    stateDb = db;
    hitlStack = createHitlPendingResolutionStack(db);
  } catch (e) {
    rt.logger.warn("state database unavailable; control plane uses ephemeral agent tokens", {
      err: String(e),
    });
  }

  let hitlDiscordNoticeRegistry: HitlDiscordNoticeRegistry | undefined;
  let hitlAutoApproveGate: HitlAutoApproveGate | undefined;
  const reactionBotUserIdRef = { current: undefined as string | undefined };
  if (hitlStack && stateDb) {
    hitlDiscordNoticeRegistry = createHitlDiscordNoticeRegistry();
    hitlAutoApproveGate = createPersistingHitlAutoApproveGate({
      db: stateDb,
      configDirectory: configRef.current.configDirectory,
      configRef,
      hitlRef,
      logger: rt.logger.child({ subsystem: "hitl-auto-approve" }),
    });
  }

  try {
    await startControlPlane({
      config,
      policyEngine,
      logger: rt.logger.child({ subsystem: "control" }),
      shutdown: rt.shutdown,
      getHealth: () => rt.getHealth(),
      version: VERSION,
      stateDb,
      hitlPending: hitlStack?.pending,
    });
    const stopConfigHotReload = startConfigHotReload({
      configDirectory: config.configDirectory,
      logger: rt.logger.child({ subsystem: "config-hot-reload" }),
      configRef,
      policyRef,
      hitlRef,
      enabled: isConfigHotReloadEnabled(config),
    });
    rt.shutdown.registerDrain("config-hot-reload", () => {
      stopConfigHotReload();
    });
  } catch (e) {
    rt.logger.error("control plane failed to start", { err: String(e) });
  }

  rt.shutdown.registerDrain("stop-event-loops", () => {
    stopEventLoops();
  });

  const msgLog = rt.logger.child({ subsystem: "messaging" });
  try {
    discordMessaging = await startDaemonDiscordMessaging({
      logger: msgLog,
      config: configRef.current,
      botToken: resolvedDiscordBotToken(),
      onMessageReactionAdd:
        hitlStack && hitlDiscordNoticeRegistry && hitlAutoApproveGate
          ? (ev) =>
              handleDiscordHitlReactionAdd({
                ev,
                pending: hitlStack.pending,
                registry: hitlDiscordNoticeRegistry!,
                autoApprove: hitlAutoApproveGate!,
                ownerUserId: resolveDiscordOwnerUserId(configRef.current),
                botUserIdRef: reactionBotUserIdRef,
                logger: msgLog.child({ subsystem: "discord-reactions" }),
              })
          : undefined,
      reactionBotUserIdRef,
    });
    if (discordMessaging) {
      rt.shutdown.registerDrain("discord-messaging", () => discordMessaging!.stop());
    }
  } catch (e) {
    msgLog.warn("discord messaging failed to start", { err: String(e) });
  }

  if (!stateDb) {
    rt.logger.warn("plugins and event loops skipped (no state database)");
    return;
  }

  const db = stateDb;
  const evLog = rt.logger.child({ subsystem: "events" });
  const boot = runBootReconciliation(db, {
    staleClaimMs: resolveBootStaleClaimMs(configRef.current),
    orphanedToolRunReason: "restart_reconciliation",
  });
  if (boot.staleEventsRequeued > 0 || boot.toolRunsMarkedFailed > 0) {
    evLog.info("boot reconciliation", {
      staleEventsRequeued: boot.staleEventsRequeued,
      toolRunsMarkedFailed: boot.toolRunsMarkedFailed,
    });
  }

  try {
    await bootstrapPlugins({
      config,
      db,
      rt,
      resolveFromFile: fileURLToPath(import.meta.url),
    });
  } catch (e) {
    rt.logger.warn("plugin bootstrap failed", { err: String(e) });
  }
  stateShutdown.db = db;
  stateShutdown.toolRuns = createToolRunStore(db);

  const dm = discordMessaging;
  if (dm && hitlStack) {
    const discordPlatform = await startDiscordPlatform({
      db,
      config,
      configRef,
      policyEngine,
      hitlConfigRef: hitlRef,
      hitlPending: hitlStack,
      hitlDiscordNoticeRegistry,
      hitlAutoApproveGate,
      logger: msgLog.child({ subsystem: "discord" }),
      discord: dm,
      deps: defaultDiscordAssistantDeps,
    });
    const subagentExt = {
      runSessionModelTurn: discordPlatform.runSessionModelTurn,
      subscribeSubagentSession: discordPlatform.subscribeSubagentSession,
      registerDiscordThreadBinding: dm.registerDiscordThreadBinding,
      announceBoundSubagentSessionEnded: discordPlatform.announceBoundSubagentSessionEnded,
    };
    setSubagentRuntimeExtension(subagentExt);
    messageToolContextRef.current = {
      slice: messageToolSliceFromCapabilities(dm.capabilities),
      execute: (sessionId, args) =>
        executeDiscordMessageToolAction(
          {
            capabilities: dm.capabilities,
            transport: dm.discordRestTransport,
            sessionToChannel: (sid) => dm.resolveOutboundChannelIdForSession?.(sid),
          },
          sessionId,
          args,
        ),
    };
    const subRecon = reconcilePersistentBoundSubagents({
      db,
      config,
      logger: msgLog.child({ subsystem: "subagent-reconcile" }),
      ext: subagentExt,
    });
    if (subRecon.restored > 0 || subRecon.expiredKilled > 0) {
      msgLog.info("subagent.persisted_reconciled", {
        restored: subRecon.restored,
        expired_killed: subRecon.expiredKilled,
      });
    }
    rt.shutdown.registerDrain("discord", async () => {
      await discordPlatform.stop();
      setSubagentRuntimeExtension(undefined);
      messageToolContextRef.current = undefined;
    });
  }

  const heartbeatMs = resolveHeartbeatIntervalMs(configRef.current);
  const cronMs = resolveCronTickIntervalMs(configRef.current);
  const batchLimit = resolveHeartbeatBatchSize(configRef.current);
  const concurrency = resolveHeartbeatConcurrency(configRef.current);
  const handlers = createDefaultHeartbeatHandlers({ logger: evLog });

  const hbTimer = setInterval(() => {
    void runHeartbeatBatch(db, {
      batchLimit,
      concurrency,
      handlers,
      logger: evLog,
    }).catch((e) => {
      evLog.error("heartbeat batch failed", { err: String(e) });
    });
  }, heartbeatMs);

  const cronTimer = setInterval(() => {
    try {
      const n = runCronTick(db);
      if (n > 0) evLog.debug("cron tick fired", { count: n });
    } catch (e) {
      evLog.error("cron tick failed", { err: String(e) });
    }
  }, cronMs);

  const retentionMs = retentionScheduleIntervalMs(configRef.current);
  const retentionTimer =
    retentionMs > 0
      ? setInterval(() => {
          void runRetentionJobs(db, config, { correlationId: `retention-${Date.now()}` })
            .then((summary) => {
              if (
                summary.inboundMediaDeletedFiles > 0 ||
                summary.transcriptMessagesDeleted > 0
              ) {
                evLog.info("retention tick", { ...summary });
              }
            })
            .catch((e) => {
              evLog.error("retention tick failed", { err: String(e) });
            });
        }, retentionMs)
      : undefined;

  const compactMs = transcriptAutoCompactIntervalMs(configRef.current);
  const compactTimer =
    compactMs > 0
      ? setInterval(() => {
          void runTranscriptAutoCompactTick(db, config, {
            logger: evLog.child({ component: "auto-compact" }),
          }).catch((e) => {
            evLog.error("transcript auto-compact tick failed", { err: String(e) });
          });
        }, compactMs)
      : undefined;

  stopEventLoops = () => {
    clearInterval(hbTimer);
    clearInterval(cronTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (compactTimer) clearInterval(compactTimer);
  };
})();

rt.health.register(createSqliteProbe({ getPath: () => config.stateDbPath }));
rt.health.register(createDiscordProbe({ getToken: resolvedDiscordBotToken }));
rt.health.register(
  createModelEndpointProbe({
    getBaseUrl: () => resolveModelHealthProbeBaseUrl(configRef.current),
  }),
);

rt.logger.info("daemon starting", {
  version: VERSION,
  stateDbPath: config.stateDbPath,
  socketPath: config.socketPath,
});

void rt.getHealth().then((h) => {
  rt.logger.info("initial health", {
    ready: h.ready,
    checks: h.checks,
  });
});

void rt.shutdown.finished.then(() => {
  rt.logger.info("shutdown complete");
  process.exit(0);
});

setInterval(() => {}, 86_400_000);
