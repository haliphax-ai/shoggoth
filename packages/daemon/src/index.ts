import {
  DEFAULT_HITL_CONFIG,
  loadLayeredConfig,
  LAYOUT,
  resolvePlatformConfig,
  VERSION,
} from "@shoggoth/shared";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readGitHash(): string {
  try {
    return readFileSync(resolve("/app/.git-hash"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}
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
  fetchGeminiMetadataForProviders,
  fetchOpenAIMetadataForProviders,
} from "./health";
import {
  initModelMetadataFromConfig,
  registerAnthropicDefaultsForProviders,
  registerOpenAIDefaultsForProviders,
} from "./model-metadata";
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
  resolveModelHealthProbeApiKey,
  resolveEmbeddingsHealthProbeBaseUrl,
  resolveEmbeddingsHealthProbeApiKey,
} from "./config/effective-runtime";
import { startControlPlane } from "./control/control-plane";
import {
  handleIntegrationControlOp,
  type IntegrationOpsContext,
} from "./control/integration-ops";
import { WIRE_VERSION } from "@shoggoth/authn";
import { requestSessionTurnAbort } from "./sessions/session-turn-abort";
import { createSessionStore } from "./sessions/session-store";
import { createLogger } from "./logging";
import { createDelegatingPolicyEngine, createPolicyEngine } from "./policy/engine";
import { bootstrapPlugins } from "./plugins/bootstrap";
import { bootstrapMainSession } from "./bootstrap-main-session";
import { createDaemonRuntime } from "./runtime";
import { initProcessManager } from "./process-manager-singleton";
import { setProcessManager } from "@shoggoth/os-exec";
import type { ProcessDeclaration } from "@shoggoth/shared";
import type { ProcessSpec } from "@shoggoth/procman";
import { createToolRunStore } from "./sessions/tool-run-store";
import {
  startDiscordPlatform,
  startDaemonDiscordMessaging,
  createDiscordInteractionHandler,
  type DiscordMessagingRuntime,
  handleDiscordHitlReactionAdd,
  createHitlDiscordNoticeRegistry,
  type HitlDiscordNoticeRegistry,
  executeDiscordMessageToolAction,
  registerBuiltInMessagingPlatforms,
} from "@shoggoth/platform-discord";
import { registerPlatform, stopAllPlatforms } from "./platforms/platform-registry";
import { reconcilePersistentBoundSubagents } from "./subagent/reconcile-persistent-bound-subagents";
import {
  messageToolContextRef,
  messageToolSliceFromCapabilities,
} from "./messaging/message-tool-context-ref";
import { setSubagentRuntimeExtension } from "./subagent/subagent-extension-ref";
import { defaultDiscordAssistantDeps } from "./sessions/assistant-runtime";
import { createPersistingHitlAutoApproveGate } from "./hitl/hitl-auto-approve-persisting";
import { type HitlAutoApproveGate } from "./hitl/hitl-auto-approve";
import { createHitlPendingResolutionStack, type HitlPendingStack } from "./hitl/hitl-pending-stack";
import { daemonNotice, loadDaemonNotices } from "./notices/load-notices";
import { loadDaemonPrompts } from "./prompts/load-prompts";
import { registerContextFinalizer } from "./sessions/session-mcp-runtime";
import {
  messageToolFinalizer,
  subagentToolStripFinalizer,
} from "./sessions/session-mcp-tool-context";

loadDaemonPrompts();
loadDaemonNotices();
registerBuiltInMessagingPlatforms();
registerContextFinalizer(messageToolFinalizer);
registerContextFinalizer(subagentToolStripFinalizer);

const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
const config = loadLayeredConfig(configDir);

const configRef = { current: config };

// Initialize model metadata store from config and register known defaults.
if (config.models?.failoverChain) {
  initModelMetadataFromConfig(config.models.failoverChain);
}
if (config.models?.providers) {
  registerAnthropicDefaultsForProviders(config.models.providers);
}
if (config.models?.providers && config.models?.failoverChain) {
  registerOpenAIDefaultsForProviders(config.models.providers, config.models.failoverChain);
}

/** Env `DISCORD_BOT_TOKEN` overrides layered `discord.token` (hot-reload picks up config changes). */
function resolvedDiscordBotToken(): string | undefined {
  const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const dc = resolvePlatformConfig(configRef.current, "discord");
  return (dc?.token as string | undefined)?.trim() || undefined;
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

    bootstrapMainSession({
      db,
      config,
      logger: rt.logger.child({ subsystem: "bootstrap" }),
    });

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
      hitlClear:
        hitlStack && stateDb && hitlAutoApproveGate
          ? {
              configDirectory: configRef.current.configDirectory,
              configRef,
              hitlRef,
              autoApproveGate: hitlAutoApproveGate,
            }
          : undefined,
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
    const interactionTransportRef: { current: DiscordMessagingRuntime["discordRestTransport"] | undefined } = { current: undefined };
    discordMessaging = await startDaemonDiscordMessaging({
      logger: msgLog,
      config: configRef.current,
      botToken: resolvedDiscordBotToken(),
      noticeResolver: daemonNotice,
      onInteractionCreate: createDiscordInteractionHandler({
        transport: new Proxy({} as DiscordMessagingRuntime["discordRestTransport"], {
          get(_t, prop, receiver) {
            if (!interactionTransportRef.current) throw new Error("discord transport not ready");
            return Reflect.get(interactionTransportRef.current, prop, receiver);
          },
        }),
        logger: msgLog,
        abortSession: async (sessionId) => requestSessionTurnAbort(sessionId ?? ""),
        invokeControlOp: async (op, payload) => {
          if (!stateDb) return { ok: false, error: "state database unavailable" };
          const sessions = createSessionStore(stateDb);
          const ctx: IntegrationOpsContext = {
            config: configRef.current,
            stateDb,
            acpxStore: undefined,
            sessions,
            sessionManager: undefined,
            acpxSupervisor: undefined,
            hitlPending: hitlStack?.pending,
            recordIntegrationAudit: () => {},
          };
          const req = {
            v: WIRE_VERSION,
            id: randomUUID(),
            op,
            auth: { kind: "operator_peercred" as const },
            payload,
          };
          const principal = { kind: "operator" as const, operatorId: "discord-slash", roles: ["admin"], source: "cli_operator_token" as const };
          const result = await handleIntegrationControlOp(req, principal, ctx);
          return { ok: true, result };
        },
        resolveSessionForChannel: (channelId, guildId) => {
          try {
            const routes = (configRef.current.platforms as Record<string, unknown>)?.discord as Record<string, unknown> | undefined;
            const routesList = routes?.routes;
            if (!Array.isArray(routesList)) return undefined;
            for (const r of routesList) {
              if (typeof r !== "object" || r === null) continue;
              const route = r as { channelId?: string; sessionId?: string; guildId?: string };
              if (route.channelId !== channelId) continue;
              if (route.guildId !== undefined && route.guildId !== guildId) continue;
              if (route.guildId === undefined && guildId !== undefined) continue;
              return route.sessionId;
            }
            return undefined;
          } catch {
            return undefined;
          }
        },
      }),
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
      interactionTransportRef.current = discordMessaging.discordRestTransport;
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

  // --- Process Manager: init singleton, start boot-time processes, register shutdown ---
  const procman = initProcessManager();
  setProcessManager(procman);

  function processDeclarationToSpec(decl: ProcessDeclaration): ProcessSpec {
    return {
      id: decl.id,
      label: decl.label,
      owner: { kind: "plugin", scopeId: decl.id },
      command: decl.command,
      args: decl.args,
      cwd: decl.cwd,
      env: decl.env,
      restart: {
        mode: decl.restartMode ?? "on-failure",
        maxRetries: decl.maxRetries ?? 5,
      },
      health: decl.health
        ? decl.health.kind === "tcp"
          ? { kind: "tcp", port: Number(decl.health.target), timeoutMs: decl.health.timeoutMs }
          : decl.health.kind === "http"
            ? { kind: "http", url: decl.health.target, timeoutMs: decl.health.timeoutMs }
            : { kind: "stdout-match", pattern: decl.health.target, timeoutMs: decl.health.timeoutMs }
        : undefined,
    };
  }

  const bootProcesses = (config.processes ?? []).filter((d) => d.startPolicy === "boot");
  for (const decl of bootProcesses) {
    try {
      await procman.start(processDeclarationToSpec(decl));
      rt.logger.info("boot process started", { processId: decl.id });
    } catch (e) {
      rt.logger.error("boot process failed to start", { processId: decl.id, err: String(e) });
    }
  }

  rt.shutdown.registerDrain("procman", async () => {
    await procman.stopAll();
  });

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
    registerPlatform("discord", discordPlatform);
    const subagentExt = {
      runSessionModelTurn: discordPlatform.runSessionModelTurn,
      subscribeSubagentSession: discordPlatform.subscribeSubagentSession,
      registerPlatformThreadBinding: dm.registerPlatformThreadBinding,
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
            sessionToGuild: (sid) => dm.resolveGuildIdForSession?.(sid),
            getSessionWorkspace: (sid) => {
              try {
                const row = db.prepare("SELECT workspace_path FROM sessions WHERE id = ?").get(sid) as
                  | { workspace_path: string }
                  | undefined;
                return row?.workspace_path;
              } catch {
                return undefined;
              }
            },
            downloadFile: async (url, destPath) => {
              const res = await fetch(url);
              if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
              const buf = Buffer.from(await res.arrayBuffer());
              const { writeFile, mkdir } = await import("node:fs/promises");
              const { dirname } = await import("node:path");
              await mkdir(dirname(destPath), { recursive: true });
              await writeFile(destPath, buf);
              return buf.byteLength;
            },
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
    rt.shutdown.registerDrain("platforms", async () => {
      await stopAllPlatforms();
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
    getApiKey: () => resolveModelHealthProbeApiKey(configRef.current),
  }),
);

// Embeddings endpoint probe
rt.health.register(
  createModelEndpointProbe({
    name: "embeddings",
    getBaseUrl: () => resolveEmbeddingsHealthProbeBaseUrl(configRef.current),
    getApiKey: () => resolveEmbeddingsHealthProbeApiKey(configRef.current),
  }),
);

rt.logger.info("daemon starting", {
  version: VERSION,
  hashref: readGitHash(),
  stateDbPath: config.stateDbPath,
  socketPath: config.socketPath,
});

void rt.getHealth().then((h) => {
  const checks = h.checks ?? [];
  const sqliteFailed = checks.some((c) => c.name === "sqlite" && c.status === "fail");
  const modelChecks = checks.filter((c) => c.name === "model");
  const allModelsFailed = modelChecks.length > 0 && modelChecks.every((c) => c.status === "fail");
  const anyNonModelFailed = checks.some((c) => (c.name === "embeddings" || c.name === "discord") && c.status === "fail");
  const someModelFailed = modelChecks.some((c) => c.status === "fail");

  const level = sqliteFailed || allModelsFailed ? "error" : anyNonModelFailed || someModelFailed ? "warn" : "info";
  rt.logger[level]("initial health", {
    ready: h.ready,
    checks: h.checks,
  });

  // Fetch Gemini model metadata after a successful model health check.
  const modelPassed = modelChecks.some((c) => c.status === "pass");
  if (modelPassed && config.models?.providers && config.models?.failoverChain) {
    void fetchGeminiMetadataForProviders(
      config.models.providers,
      config.models.failoverChain,
      process.env,
      rt.logger,
    );
    void fetchOpenAIMetadataForProviders(
      config.models.providers,
      config.models.failoverChain,
      process.env,
      rt.logger,
    );
  }
});

void rt.shutdown.finished.then(() => {
  rt.logger.info("shutdown complete");
  process.exit(0);
});

setInterval(() => {}, 86_400_000);
