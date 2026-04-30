import { DEFAULT_HITL_CONFIG, loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { routeMcpToolInvocation } from "@shoggoth/mcp-integration";
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
import { createDefaultHeartbeatHandlers, runHeartbeatBatch } from "./events/heartbeat-consumer";
import {
  createSqliteProbe,
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
import { handleIntegrationControlOp, type IntegrationOpsContext } from "./control/integration-ops";
import { WIRE_VERSION } from "@shoggoth/authn";
import { requestSessionTurnAbort } from "./sessions/session-turn-abort";
import { createSessionStore } from "./sessions/session-store";
import { initLogger, getLogger } from "./logging";

const log = getLogger("shoggoth-daemon");
import { createDelegatingPolicyEngine, createPolicyEngine } from "./policy/engine";
import { pluginAuditToRow } from "./plugins/bootstrap";
import { bootstrapMainSession } from "./bootstrap-main-session";
import { createDaemonRuntime } from "./runtime";
import { initProcessManager } from "./process-manager-singleton";
import { setProcessManager } from "@shoggoth/os-exec";
import type { ProcessDeclaration } from "@shoggoth/shared";
import type { ProcessSpec } from "@shoggoth/procman";
import { createToolRunStore } from "./sessions/tool-run-store";
import { registerPlatform as registerMessagingPlatform } from "@shoggoth/messaging";
import { registerPlatform, stopAllPlatforms } from "./platforms/platform-registry";
import { reconcilePersistentSubagents } from "./subagent/reconcile-persistent-subagents";
import { messageToolContextRef } from "./messaging/message-tool-context-ref";
import {
  setSubagentRuntimeExtension,
  subagentRuntimeExtensionRef,
} from "./subagent/subagent-extension-ref";
import { defaultPlatformAssistantDeps } from "./sessions/assistant-runtime";
import { createPersistingHitlAutoApproveGate } from "./hitl/hitl-auto-approve-persisting";
import { type HitlAutoApproveGate } from "./hitl/hitl-auto-approve";
import { createHitlPendingResolutionStack, type HitlPendingStack } from "./hitl/hitl-pending-stack";
import { daemonNotice, loadDaemonNotices } from "./notices/load-notices";
import { setNoticeResolver as setPresentationNoticeResolver } from "./presentation/notices";
import { loadDaemonPrompts } from "./prompts/load-prompts";
import { registerContextFinalizer, getSessionMcpRuntimeRef } from "./sessions/session-mcp-runtime";
import { getBuiltinToolRegistry } from "./sessions/session-agent-turn";
import type { PlatformAdapter } from "./presentation/platform-adapter";

const platformAdapterRef: { current?: PlatformAdapter } = {
  current: undefined,
};
import {
  messageToolFinalizer,
  subagentToolStripFinalizer,
} from "./sessions/session-mcp-tool-context";
import { initWorkflow } from "./workflow-singleton";
import { TieredTurnQueue } from "./sessions/session-turn-queue";
import { setTurnQueue, getTurnQueue } from "./sessions/session-turn-queue-singleton";
import { ModelResilienceGate, setResilienceGate } from "@shoggoth/models";
import {
  createDaemonSpawnAdapter,
  createDaemonPollAdapter,
  createDaemonKillAdapter,
  createDaemonMessageAdapter,
  createDaemonMessagePoster,
} from "./workflow-adapters";
import { createSessionManager } from "./sessions/session-manager";
import { createSqliteAgentTokenStore } from "./auth/sqlite-agent-tokens";
import { resolveShoggothAgentId } from "./config/effective-runtime";
import { TimerScheduler } from "./timers/timer-scheduler";
import { setTimerScheduler } from "./sessions/builtin-handlers/timer-handler";
import { ShoggothPluginSystem, type PlatformDeps } from "@shoggoth/plugins";
import { fireDaemonHooks } from "./plugins/daemon-hooks";
import { appendAuditRow } from "./audit/append-audit";

process.umask(0o007);
loadDaemonPrompts();
loadDaemonNotices();
setPresentationNoticeResolver(daemonNotice);
registerContextFinalizer(messageToolFinalizer);
registerContextFinalizer(subagentToolStripFinalizer);

const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
const config = loadLayeredConfig(configDir);

const configRef = { current: config };

initLogger({ minLevel: config.logLevel });

// Assert dynamicConfigDirectory is below configDirectory when set.
if (config.dynamicConfigDirectory) {
  const resolvedConfig = resolve(config.configDirectory);
  const resolvedDynamic = resolve(config.dynamicConfigDirectory);
  if (!resolvedDynamic.startsWith(resolvedConfig + "/") && resolvedDynamic !== resolvedConfig) {
    log.error("dynamicConfigDirectory must be below configDirectory", {
      resolvedDynamic,
      resolvedConfig,
    });
    process.exit(1);
  }
}

// Initialize model metadata store from config and register known defaults.
if (config.models?.failoverChain) {
  initModelMetadataFromConfig(config.models.failoverChain, config.models.providers);
}
if (config.models?.providers) {
  registerAnthropicDefaultsForProviders(config.models.providers);
}
if (config.models?.providers && config.models?.failoverChain) {
  registerOpenAIDefaultsForProviders(config.models.providers, config.models.failoverChain);
}

const policyRef = { engine: createPolicyEngine(config.policy, config.agents) };
const policyEngine = createDelegatingPolicyEngine(() => policyRef.engine);
const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...config.hitl } };

const drainTimeoutMs = resolveDrainTimeoutMs(config);

/** Set after state DB opens; used on shutdown to fail in-flight tool runs before close. */
const stateShutdown: {
  db: ReturnType<typeof openStateDb> | undefined;
  toolRuns: ReturnType<typeof createToolRunStore> | undefined;
} = { db: undefined, toolRuns: undefined };

let stopEventLoops: () => void = () => {};

const rt = createDaemonRuntime({
  component: "shoggoth-daemon",
  logLevel: config.logLevel,
  shutdown: {
    drainTimeoutMs,
    async onStopAccepting() {
      log.info("stop accepting new work");
    },
    async markInterruptedRunsFailed(reason: string) {
      try {
        const tr = stateShutdown.toolRuns;
        if (tr) {
          const n = tr.markAllRunningFailed(reason);
          log.info("interrupted tool runs marked failed", { reason, count: n });
        }
      } catch (e) {
        log.error("mark interrupted tool runs failed", { err: String(e) });
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

    await bootstrapMainSession({
      db,
      config,
    });

    hitlStack = createHitlPendingResolutionStack(db);
  } catch (e) {
    getLogger("daemon").warn(
      "state database unavailable; control plane uses ephemeral agent tokens",
      {
        err: String(e),
      },
    );
  }

  let hitlAutoApproveGate: HitlAutoApproveGate | undefined;
  if (hitlStack && stateDb) {
    hitlAutoApproveGate = createPersistingHitlAutoApproveGate({
      db: stateDb,
      configDirectory: configRef.current.configDirectory,
      dynamicConfigDirectory: configRef.current.dynamicConfigDirectory,
      configRef,
      hitlRef,
    });
  }

  try {
    await startControlPlane({
      config,
      policyEngine,
      shutdown: rt.shutdown,
      getHealth: () => rt.getHealth(),
      version: VERSION,
      stateDb,
      hitlPending: hitlStack?.pending,
      hitlClear:
        hitlStack && stateDb && hitlAutoApproveGate
          ? {
              configDirectory: configRef.current.configDirectory,
              dynamicConfigDirectory: configRef.current.dynamicConfigDirectory,
              configRef,
              hitlRef,
              autoApproveGate: hitlAutoApproveGate,
            }
          : undefined,
    });
    const stopConfigHotReload = startConfigHotReload({
      configDirectory: config.configDirectory,
      configRef,
      policyRef,
      hitlRef,
      enabled: isConfigHotReloadEnabled(config),
    });
    rt.shutdown.registerDrain("config-hot-reload", () => {
      stopConfigHotReload();
    });
  } catch (e) {
    getLogger("daemon").error("control plane failed to start", {
      err: String(e),
    });
  }

  rt.shutdown.registerDrain("stop-event-loops", () => {
    stopEventLoops();
  });

  if (!stateDb) {
    getLogger("daemon").warn("plugins and event loops skipped (no state database)");
    return;
  }

  const db = stateDb;
  const boot = runBootReconciliation(db, {
    staleClaimMs: resolveBootStaleClaimMs(configRef.current),
    orphanedToolRunReason: "restart_reconciliation",
  });
  if (boot.staleEventsRequeued > 0 || boot.toolRunsMarkedFailed > 0) {
    getLogger("events").info("boot reconciliation", {
      staleEventsRequeued: boot.staleEventsRequeued,
      toolRunsMarkedFailed: boot.toolRunsMarkedFailed,
    });
  }

  // --- Process Manager: init singleton early so MCP stdio spawns go through procman ---
  const procman = initProcessManager();
  setProcessManager(procman);

  // --- Turn Queue: init singleton early (needed during hook-triggered turns) ---
  const starvationThreshold = config.runtime?.turnQueue?.starvationThreshold ?? 2;
  const maxQueueDepth = config.runtime?.turnQueue?.maxDepth ?? 6;
  setTurnQueue(new TieredTurnQueue(starvationThreshold, maxQueueDepth));

  // --- Model Resilience Gate: init singleton early ---
  {
    const rc = config.runtime?.modelResilience;
    const gate = new ModelResilienceGate(
      {
        maxRetries: rc?.maxRetries,
        baseDelayMs: rc?.baseDelayMs,
        maxDelayMs: rc?.maxDelayMs,
        jitterMs: rc?.jitterMs,
        defaultConcurrency: rc?.defaultConcurrency,
      },
      rc?.providers,
    );
    setResilienceGate(gate);
  }

  // Create plugin system and load plugins via standard discovery
  const pluginSystem = new ShoggothPluginSystem();
  const resolveFromFile = fileURLToPath(import.meta.url);
  {
    const { loadAllPluginsFromConfig } = await import("@shoggoth/plugins");
    const loaded = await loadAllPluginsFromConfig({
      config,
      system: pluginSystem,
      resolveFromFile,
      audit: (e) => {
        appendAuditRow(db, pluginAuditToRow(e));
        if (e.outcome === "failure") {
          getLogger("daemon").error("plugin load failed", {
            plugin: e.resource,
            detail: e.detail,
          });
        }
      },
    });
    if (loaded.length > 0) {
      getLogger("daemon").info("plugins loaded", {
        count: loaded.length,
        plugins: loaded.map((p) => p.manifestName),
      });
    }
  }

  // Build PlatformDeps - platform-agnostic callbacks the plugins need
  const platformsMap = new Map<string, any>();
  const { PlatformDeliveryRegistry } = await import("@shoggoth/plugins");
  const deliveryRegistry = new PlatformDeliveryRegistry();

  const platformDeps: PlatformDeps = {
    hitlStack,
    policyEngine,
    hitlConfigRef: hitlRef,
    hitlAutoApproveGate,
    logger: getLogger("messaging"),
    platformAssistantDeps: defaultPlatformAssistantDeps as unknown,
    abortSession: async (sessionId) => {
      return requestSessionTurnAbort(sessionId ?? "");
    },
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
        auth: { kind: "operator_token" as const, token: "__internal__" },
        payload,
      };
      const principal = {
        kind: "operator" as const,
        operatorId: "platform-slash",
        roles: ["admin"],
        source: "cli_operator_token" as const,
      };
      const result = await handleIntegrationControlOp(req, principal, ctx);
      return { ok: true, result };
    },
    registerPlatform: (platformId, handle) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerPlatform(platformId, handle as any);
      platformsMap.set(platformId, handle);
    },
    stopAllPlatforms,
    reconcilePersistentSubagents:
      reconcilePersistentSubagents as PlatformDeps["reconcilePersistentSubagents"],
    noticeResolver: daemonNotice as (key: string, params?: Record<string, unknown>) => string,
  };

  // Fire daemon hooks — plugins handle platform.start, health.register, etc.
  const hookResult = await fireDaemonHooks(pluginSystem, {
    config,
    db,
    configRef,
    env: process.env,
    platforms: platformsMap,
    deliveryRegistry,
    registerDrain: (name, fn) => rt.shutdown.registerDrain(name, fn),
    registerPlatform: (reg) => registerMessagingPlatform(reg),
    setPlatformRuntime: (platformId, runtime) => platformsMap.set(platformId, runtime),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerProbe: (probe) => rt.health.register(probe as any),
    deps: platformDeps,
    setSubagentRuntimeExtension: (ext) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setSubagentRuntimeExtension(ext as any),
    setMessageToolContext: (ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageToolContextRef.current = ctx as any;
    },
    setPlatformAdapter: (adapter) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platformAdapterRef.current = adapter as any;
    },
  });

  // Register plugin shutdown drains
  rt.shutdown.registerDrain("plugin-platform-stop", hookResult.drains.platformStop);
  rt.shutdown.registerDrain("plugin-daemon-shutdown", hookResult.drains.daemonShutdown);
  stateShutdown.db = db;
  stateShutdown.toolRuns = createToolRunStore(db);

  // --- Timer Scheduler: init, restore, register shutdown ---
  const timerScheduler = new TimerScheduler(async (sessionId, message) => {
    const ext = subagentRuntimeExtensionRef.current;
    if (!ext) {
      getLogger("timer-scheduler").warn("timer delivery skipped: subagent runtime not available", {
        sessionId,
      });
      return;
    }
    await ext.runSessionModelTurn({
      sessionId,
      userContent: message,
      userMetadata: { timer_fire: true },
      delivery: { kind: "internal" },
      systemContext: {
        kind: "timer.fire",
        summary: "This turn was triggered by a deferred timer.",
        guidance:
          "Replies to this turn will be dropped. Respond with NO_REPLY. If you need to surface information to the user, use alternate means such as the builtin-message tool.",
      },
    });
  });
  setTimerScheduler(timerScheduler);
  getTurnQueue().setOnTurnEnd((sessionId) => {
    timerScheduler.flushSession(sessionId);
  });
  try {
    await timerScheduler.restore(db);
  } catch (e) {
    getLogger("daemon").warn("timer restore failed", { err: String(e) });
  }
  rt.shutdown.registerDrain("timer-scheduler", () => {
    timerScheduler.shutdown();
  });
  // --- Process Manager: start boot-time processes, register shutdown ---

  // (TurnQueue and ModelResilienceGate initialized earlier, before fireDaemonHooks)

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
          ? {
              kind: "tcp",
              port: Number(decl.health.target),
              timeoutMs: decl.health.timeoutMs,
            }
          : decl.health.kind === "http"
            ? {
                kind: "http",
                url: decl.health.target,
                timeoutMs: decl.health.timeoutMs,
              }
            : {
                kind: "stdout-match",
                pattern: decl.health.target,
                timeoutMs: decl.health.timeoutMs,
              }
        : undefined,
    };
  }

  const bootProcesses = (config.processes ?? []).filter((d) => d.startPolicy === "boot");
  for (const decl of bootProcesses) {
    try {
      await procman.start(processDeclarationToSpec(decl));
      getLogger("daemon").info("boot process started", { processId: decl.id });
    } catch (e) {
      getLogger("daemon").error("boot process failed to start", {
        processId: decl.id,
        err: String(e),
      });
    }
  }

  rt.shutdown.registerDrain("procman", async () => {
    await procman.stopAll();
  });

  // --- Workflow tool: init server, resume incomplete workflows, register shutdown ---
  // Adapters use lazy refs because the platform plugin (and thus sessionManager,
  // runSessionModelTurn, messageToolContextRef) are initialized later in this file.
  const workflowStateDir = resolve(config.stateDbPath, "..", "workflow-state");
  try {
    const workflowSessions = createSessionStore(db);
    const workflowSessionManager = createSessionManager({
      db,
      sessions: workflowSessions,
      agentTokens: createSqliteAgentTokenStore(db),
      workspacesRoot: config.workspacesRoot,
      agentId: resolveShoggothAgentId(config),
      agentsConfig: config.agents,
    });

    const spawner = createDaemonSpawnAdapter({
      sessionManager: workflowSessionManager,
      sessions: workflowSessions,
      requestTurnAbort: (id) => requestSessionTurnAbort(id),
      runSessionModelTurn: (input) => {
        const ext = subagentRuntimeExtensionRef.current;
        if (!ext) throw new Error("subagent runtime not available (platform not started)");
        return ext.runSessionModelTurn({
          ...input,
          delivery: { kind: "internal" },
        });
      },
    });

    const poller = createDaemonPollAdapter({
      sessions: workflowSessions,
      completionMap: spawner.completionMap,
    });

    const killer = createDaemonKillAdapter({
      sessionManager: workflowSessionManager,
      requestTurnAbort: (id) => requestSessionTurnAbort(id),
    });

    const workflow = initWorkflow({
      stateDir: workflowStateDir,
      spawner,
      poller,
      notifier: {
        async notify(workflowId, success, context) {
          getLogger("daemon").info("workflow completed", {
            workflowId,
            success,
            replyTo: context?.replyTo ?? null,
          });
          try {
            const sessionId = context?.replyTo;
            if (!sessionId) {
              getLogger("daemon").warn("workflow notify: no replyTo in context");
              return;
            }

            const ext = subagentRuntimeExtensionRef.current;
            if (!ext) {
              getLogger("daemon").warn("workflow notify: subagent runtime not available");
              return;
            }

            const status = success ? "✅ completed successfully" : "❌ completed with failures";
            const message = `**Workflow ${status}:** \`${workflowId}\``;

            getLogger("daemon").debug("workflow notify: delivering to session", { sessionId });
            const delivery = deliveryRegistry.resolveOperatorDelivery(
              sessionId,
              configRef.current,
            ) ?? { kind: "internal" as const };
            getLogger("daemon").debug("workflow notify: resolved delivery", {
              sessionId,
              deliveryKind: delivery.kind,
            });
            await ext.runSessionModelTurn({
              sessionId,
              userContent: message,
              userMetadata: {
                workflow_notify: true,
                workflow_id: workflowId,
                success,
              },
              systemContext: {
                kind: "workflow.complete",
                summary: `Workflow completed ${success ? "successfully" : "with failures"}.`,
                guidance:
                  "The user can already see task statuses, durations, total duration, and workflow completion in the automated status post. Surface any meaningful information beyond that, or simply acknowledge completion in your own voice.",
                data: { workflow_id: workflowId, success },
              },
              delivery,
            });
            getLogger("daemon").debug("workflow notify: delivered");
          } catch (e) {
            getLogger("daemon").warn("workflow completion notification failed", {
              workflowId,
              err: String(e),
            });
          }
        },
      },
      killer,
      createMessageAdapter: (sessionId: string) =>
        createDaemonMessageAdapter({
          getMessageContext: () => messageToolContextRef.current ?? undefined,
          resolveChannelId: () => {
            // This will be resolved after platform starts - the platform adapter handles this
            return undefined;
          },
          sessionId,
        }),
      createMessagePoster: (_sessionId: string) =>
        createDaemonMessagePoster({
          sendBody: async (target: string, body: string) => {
            const adapter = platformAdapterRef.current;
            if (!adapter) throw new Error("platform adapter not available");
            await adapter.sendBody(target, body);
          },
          logger: getLogger("workflow-message-poster"),
        }),

      createToolExecutor: (sessionId: string) => ({
        async execute({ name, argsJson, toolCallId }) {
          const runtime = getSessionMcpRuntimeRef();
          if (!runtime) throw new Error("MCP runtime not available");
          const ctx = await runtime.resolveContext(sessionId);
          if (!ctx) throw new Error("no MCP context for session " + sessionId);
          const routed = routeMcpToolInvocation(ctx.aggregated, name);
          if ("error" in routed) throw new Error(routed.error);
          if (routed.tool.sourceId === "builtin") {
            const registry = getBuiltinToolRegistry();
            const toolCtx = {
              sessionId,
              db,
              config: configRef.current,
              env: process.env,
              workspacePath: configRef.current.workspacesRoot ?? LAYOUT.workspacesRoot,
              creds: {
                uid: process.getuid?.() ?? 0,
                gid: process.getgid?.() ?? 0,
              },
              orchestratorEnv: process.env,
              getAgentIntegrationInvoker: () => undefined,
              getProcessManager: () => procman,
              messageToolCtx: messageToolContextRef.current ?? undefined,
              memoryConfig: configRef.current.memory ?? {},
              runtimeOpenaiBaseUrl: configRef.current.runtime?.openaiBaseUrl,
              isSubagentSession: true,
            };
            const result = await registry.execute(
              routed.tool.originalName,
              JSON.parse(argsJson),
              toolCtx,
            );
            return { resultJson: result.resultJson };
          }
          if (!ctx.external) throw new Error("no external MCP transport for session " + sessionId);
          return ctx.external({
            sourceId: routed.tool.sourceId,
            originalName: routed.tool.originalName,
            argsJson,
            toolCallId,
          });
        },
      }),
      createNotificationAdapter: (_replyToSessionId: string) => ({
        async sendNotification(target: string, message: string): Promise<void> {
          const ext = subagentRuntimeExtensionRef.current;
          if (!ext) {
            getLogger("daemon").warn("workflow task notification: subagent runtime not available");
            return;
          }
          const delivery = deliveryRegistry.resolveOperatorDelivery(target, configRef.current) ?? {
            kind: "internal" as const,
          };
          try {
            await ext.runSessionModelTurn({
              sessionId: target,
              userContent: message,
              userMetadata: { workflow_task_failed: true },
              systemContext: {
                kind: "workflow.task_failed",
                summary: message,
                guidance:
                  "A task in a running workflow has failed. Assess whether this requires intervention, a retry, or can be ignored. The user can see the failure in the status post — only surface this if you have actionable context to add.",
              },
              delivery,
            });
          } catch (e) {
            getLogger("daemon").warn("workflow task failure notification failed", {
              target,
              err: String(e),
            });
          }
        },
      }),
    });

    const resumed = await workflow.server.resume();
    if (resumed.length > 0) {
      getLogger("daemon").info("workflow resumed incomplete workflows", {
        count: resumed.length,
        ids: resumed,
      });
    }

    rt.shutdown.registerDrain("workflow", async () => {
      await workflow.server.stopAll();
    });
  } catch (e) {
    getLogger("daemon").warn("workflow server failed to initialize", {
      err: String(e),
    });
  }

  const heartbeatMs = resolveHeartbeatIntervalMs(configRef.current);
  const cronMs = resolveCronTickIntervalMs(configRef.current);
  const batchLimit = resolveHeartbeatBatchSize(configRef.current);
  const concurrency = resolveHeartbeatConcurrency(configRef.current);
  const handlers = createDefaultHeartbeatHandlers();

  const hbTimer = setInterval(() => {
    void runHeartbeatBatch(db, {
      batchLimit,
      concurrency,
      handlers,
    }).catch((e) => {
      getLogger("events").error("heartbeat batch failed", { err: String(e) });
    });
  }, heartbeatMs);

  const cronTimer = setInterval(() => {
    try {
      const n = runCronTick(db);
      if (n > 0) getLogger("events").debug("cron tick fired", { count: n });
    } catch (e) {
      getLogger("events").error("cron tick failed", { err: String(e) });
    }
  }, cronMs);

  const retentionMs = retentionScheduleIntervalMs(configRef.current);
  const retentionTimer =
    retentionMs > 0
      ? setInterval(() => {
          void runRetentionJobs(db, config, {
            correlationId: `retention-${Date.now()}`,
          })
            .then((summary) => {
              if (summary.inboundMediaDeletedFiles > 0 || summary.transcriptMessagesDeleted > 0) {
                getLogger("events").info("retention tick", { ...summary });
              }
            })
            .catch((e) => {
              getLogger("events").error("retention tick failed", {
                err: String(e),
              });
            });
        }, retentionMs)
      : undefined;

  stopEventLoops = () => {
    clearInterval(hbTimer);
    clearInterval(cronTimer);
    if (retentionTimer) clearInterval(retentionTimer);
  };
})();

rt.health.register(createSqliteProbe({ getPath: () => config.stateDbPath }));
// Note: Platform health probes are registered by plugins via health.register hook
rt.health.register(
  createModelEndpointProbe({
    getBaseUrl: () => resolveModelHealthProbeBaseUrl(configRef.current),
    getApiKey: () => resolveModelHealthProbeApiKey(configRef.current),
    getProviderKind: () => configRef.current.models?.providers?.[0]?.kind,
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

getLogger("daemon").info("daemon starting", {
  version: VERSION,
  hashref: readGitHash(),
  stateDbPath: config.stateDbPath,
  socketPath: config.socketPath,
});

void (async () => {
  const INITIAL_HEALTH_RETRIES = 4;
  const INITIAL_HEALTH_RETRY_DELAY_MS = 3000;
  let h = await rt.getHealth();
  for (let attempt = 1; attempt < INITIAL_HEALTH_RETRIES; attempt++) {
    const modelChecks = (h.checks ?? []).filter((c) => c.name === "model");
    if (modelChecks.length === 0 || modelChecks.some((c) => c.status === "pass")) break;
    getLogger("daemon").debug("initial health: model probe failed, retrying", {
      attempt,
      delay: INITIAL_HEALTH_RETRY_DELAY_MS,
    });
    await new Promise((r) => setTimeout(r, INITIAL_HEALTH_RETRY_DELAY_MS));
    h = await rt.getHealth();
  }
  const checks = h.checks ?? [];
  const sqliteFailed = checks.some((c) => c.name === "sqlite" && c.status === "fail");
  const modelChecks = checks.filter((c) => c.name === "model");
  const allModelsFailed = modelChecks.length > 0 && modelChecks.every((c) => c.status === "fail");
  const anyNonModelFailed = checks.some(
    (c) => c.name !== "sqlite" && c.name !== "model" && c.status === "fail",
  );
  const someModelFailed = modelChecks.some((c) => c.status === "fail");

  const level =
    sqliteFailed || allModelsFailed
      ? "error"
      : anyNonModelFailed || someModelFailed
        ? "warn"
        : "info";
  getLogger("daemon")[level]("initial health", {
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
      getLogger("daemon"),
    );
    void fetchOpenAIMetadataForProviders(
      config.models.providers,
      config.models.failoverChain,
      process.env,
      getLogger("daemon"),
    );
  }
})();

void rt.shutdown.finished.then(() => {
  getLogger("daemon").info("shutdown complete");
  process.exit(0);
});

setInterval(() => {}, 86_400_000);
