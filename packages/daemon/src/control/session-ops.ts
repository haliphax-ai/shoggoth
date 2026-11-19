/**
 * Control plane session operations: `session_list`, `session_context_status`,
 * `session_inspect`, `session_send`, `session_steer`, `session_abort`,
 * `session_kill`, `session_model`, and `session_queue_manage`.
 *
 * Extracted verbatim from `integration-ops.ts` (case bodies byte-for-byte;
 * every error message and audit action preserved).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { ShoggothModelsConfig } from "@shoggoth/shared";
import {
  assertValidAgentId,
  modelProvidersToEntries,
  parseAgentSessionUrn,
  resolveEffectiveModelsConfig,
} from "@shoggoth/shared";
import type { SessionSortBy } from "../sessions/session-store";
import { getLogger } from "../logging";
import {
  getSessionStats,
  getContextFill,
  buildFormattedStats,
} from "../sessions/session-stats-store";
import { requestSessionTurnAbort } from "../sessions/session-turn-abort";
import type { SessionRow } from "../sessions/session-store";
import { validateModelRefExists, getSessionPrimaryModelRef } from "../sessions/model-resolution";
import { getModelContextWindowTokens } from "../model-metadata";
import { postTurnSurfaceNotice } from "../presentation/active-turn-surface";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { buildSessionMessageTurnBanner } from "../messaging/oob-turn-banner";
import { terminatePersistentSubagentSession } from "../subagent/subagent-kill";
import { pushSteer } from "../sessions/steer-channel";
import { buildSteerBanner } from "../messaging/in-turn-event";
import { getTurnQueue } from "../sessions/session-turn-queue-singleton";
import { assertDeliveryTargetNotTerminated } from "./ops-shared";
import {
  payloadObject,
  requireString,
  optionalFinitePositiveInt,
  optionalBooleanFlag,
  mapSessionListRow,
  requireSessionId,
  requireSubagentRuntime,
  resolveSessionSendTargetSessionId,
  assertAgentMayTargetSessionForSendOrList,
  assertAgentMayUseSubagentSessionOps,
} from "./ops-shared";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

const ioLog = getLogger("integration-ops");

/** Split a `providerId/model` ref at its first slash. */
function splitModelRef(ref: string): { providerId: string; modelName: string } {
  const p = ref.indexOf("/");
  const providerId = ref.slice(0, p);
  const modelName = ref.slice(p + 1);
  return { providerId, modelName };
}

/**
 * Surface the model-switch cap-reduction warning: folded into the live
 * turn's output when a turn surface exists, standalone status post
 * otherwise (verbatim fallback behavior).
 */
function notifyModelSwitchCapReduced(
  sessionId: string,
  requestedRef: string,
  newWindow: number,
  oldWindow: number,
): void {
  const notice = `> ⚠️ Context window cap reduced by model switch: ${oldWindow.toLocaleString("en-US")} → ${newWindow.toLocaleString("en-US")} tokens (\`${requestedRef}\`)`;
  const ext = subagentRuntimeExtensionRef.current;
  if (postTurnSurfaceNotice(sessionId, notice) || !ext) return;
  void ext.sendStatusMessage?.(sessionId, notice).catch((e: unknown) => {
    ioLog.warn("session_model reduced-window notice failed", {
      sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
  });
}

/** Session model info shape returned by `session_list` and `session_context_status`. */
interface SessionModelInfo {
  providerId: string | null;
  model: string | null;
}

/**
 * Resolve a session row's effective model info for control-plane output:
 * explicit `modelSelection` first, then the effective failover chain's head.
 * Non-object selections (null / invocation-only tweak) return the fallback
 * from the models config instead.
 */
function sessionModelInfo(row: SessionRow, modelsConfig: ShoggothModelsConfig | undefined) {
  let providerId: string | null = null;
  let modelName: string | null = null;
  const modelSel = row.modelSelection as Record<string, unknown> | undefined;
  if (modelSel && typeof modelSel === "object") {
    providerId = (modelSel.providerId as string) ?? null;
    modelName = (modelSel.model as string) ?? null;
  }
  if (!providerId || !modelName) {
    const chain = modelsConfig?.failoverChain;
    if (chain && chain.length > 0) {
      const first = chain[0];
      const [parsedProviderId, ...modelParts] = first.split("/");
      if (!providerId) providerId = parsedProviderId ?? null;
      if (!modelName) modelName = modelParts.join("/") || null;
    }
  }
  return { providerId, model: modelName };
}

/** True when `value` is a finite number `>= min` (1-based wire-index guard). */
function isNumberAtLeast(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min;
}

/**
 * Handle session_list control operation.
 */
export async function handleSessionList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_list requires operator or agent principal",
      );
    }
    if (!ctx.stateDb || !ctx.sessions) {
      throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session_list requires state database");
    }
    const pl = payloadObject(req);
    const statusRaw = pl.status;
    const status = typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : undefined;
    const agentFilterRaw = pl.agent;
    const agentFilter =
      typeof agentFilterRaw === "string" && agentFilterRaw.trim()
        ? agentFilterRaw.trim()
        : undefined;

    // --- New sort / filter / limit parameters ---
    const VALID_SORT_BY = new Set(["created", "lastActivity", "name"]);
    const sortByRaw = pl.sort_by;
    const sortBy: SessionSortBy | undefined =
      typeof sortByRaw === "string" && VALID_SORT_BY.has(sortByRaw)
        ? (sortByRaw as SessionSortBy)
        : undefined;

    const sortOrderRaw = pl.sort_order;
    const sortOrder: "asc" | "desc" | undefined =
      sortOrderRaw === "asc" || sortOrderRaw === "desc" ? sortOrderRaw : undefined;

    const activeSinceRaw = pl.active_since;
    const activeSince =
      typeof activeSinceRaw === "string" && activeSinceRaw.trim()
        ? activeSinceRaw.trim()
        : undefined;

    const limit = optionalFinitePositiveInt(pl, "limit");

    if (principal.kind === "agent") {
      const callerAgentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
      if (!callerAgentId) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_list requires agent principal with a valid session URN",
        );
      }
      if (agentFilter !== undefined && agentFilter !== callerAgentId) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "agent may only list sessions for own agent id",
        );
      }
      return listSessionsWithDefaults(ctx.sessions, callerAgentId, {
        status,
        sortBy,
        sortOrder,
        activeSince,
        limit,
      });
    }

    if (agentFilter) {
      try {
        assertValidAgentId(agentFilter);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.agent: ${msg}`);
      }
    }
    return listSessionsWithDefaults(ctx.sessions, agentFilter, {
      status,
      sortBy,
      sortOrder,
      activeSince,
      limit,
    });
  }
}

/**
 * Run one shared `session_list` query: resolve the effective agent filter, list
 * sessions, and map rows — hiding terminated sessions unless an explicit
 * status filter is present. Both the agent-principal and operator branches of
 * `handleSessionList` funnel through this tail so filter construction and row
 * mapping cannot silently diverge between them.
 */
function listSessionsWithDefaults(
  sessions: NonNullable<IntegrationOpsContext["sessions"]>,
  agentId: string | undefined,
  filter: {
    readonly status?: string;
    readonly sortBy?: SessionSortBy;
    readonly sortOrder?: "asc" | "desc";
    readonly activeSince?: string;
    readonly limit?: number;
  },
): { sessions: ReturnType<typeof mapSessionListRow>[] } {
  const rows = sessions.list({ ...filter, agentId });
  const filtered = filter.status ? rows : rows.filter((r) => r.status !== "terminated");
  return { sessions: filtered.map(mapSessionListRow) };
}

/**
 * Handle session_context_status control operation.
 */
export async function handleSessionContextStatus(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_context_status requires operator or agent principal",
      );
    }
    if (!ctx.stateDb) {
      throw new IntegrationOpError(
        "ERR_STATE_DB_REQUIRED",
        "session_context_status requires state database",
      );
    }
    if (!ctx.sessions) {
      throw new IntegrationOpError(
        "ERR_STATE_DB_REQUIRED",
        "session_context_status requires session store",
      );
    }
    const sessionsStore = ctx.sessions;
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    if (principal.kind === "agent" && sessionId !== principal.sessionId) {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "agent may only session_context_status own session",
      );
    }
    const row = sessionsStore.getById(sessionId);
    const sessionData = row
      ? {
          id: row.id,
          status: row.status,
          agentProfileId: row.agentProfileId ?? null,
          workspacePath: row.workspacePath,
          contextSegmentId: row.contextSegmentId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
    const statsData = getSessionStats(ctx.stateDb, sessionId);
    // Context fill: provider-reported gauge when available, transcript
    // heuristic otherwise.
    let formattedStats: ReturnType<typeof buildFormattedStats> | null = null;
    if (statsData && row) {
      formattedStats = buildFormattedStats(
        statsData,
        getContextFill(ctx.stateDb, sessionId, row.contextSegmentId.trim()),
      );
    }
    let modelData: SessionModelInfo | null = null;
    if (row) {
      try {
        modelData = sessionModelInfo(row, resolveEffectiveModelsConfig(ctx.config, sessionId));
      } catch {
        modelData = null;
      }
    }
    let queueDepth: { system: number; user: number } | null = null;
    try {
      queueDepth = getTurnQueue().getDepth(sessionId);
    } catch {
      /* queue not initialized */
    }
    return {
      session: sessionData,
      stats: statsData ?? null,
      formattedStats: formattedStats ?? null,
      model: modelData,
      queueDepth,
    };
  }
}

/**
 * Handle session_inspect control operation.
 */
export async function handleSessionInspect(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_inspect requires operator or agent principal",
      );
    }
    const { sessions } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    if (principal.kind === "agent") {
      if (sessionId !== principal.sessionId) {
        throw new IntegrationOpError("ERR_FORBIDDEN", "agent may only session_inspect own session");
      }
      assertAgentMayUseSubagentSessionOps(principal, ctx);
    }
    const row = sessions.getById(sessionId);
    if (!row) {
      return { session: null };
    }
    const children = sessions.list({ parentSessionId: sessionId }).map((c) => ({
      id: c.id,
      status: c.status,
      subagent_mode: c.subagentMode ?? null,
      subagent_expires_at_ms: c.subagentExpiresAtMs ?? null,
    }));
    return {
      session: {
        id: row.id,
        status: row.status,
        parent_session_id: row.parentSessionId ?? null,
        subagent_mode: row.subagentMode ?? null,
        subagent_platform_thread_id: row.subagentPlatformThreadId ?? null,
        subagent_expires_at_ms: row.subagentExpiresAtMs ?? null,
        workspace_path: row.workspacePath,
        context_segment_id: row.contextSegmentId,
      },
      child_subagents: children,
    };
  }
}

/**
 * Handle session_send control operation.
 */
export async function handleSessionSend(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    ioLog.debug("subagent conversation: send", {
      op: req.op,
      principalKind: principal.kind,
    });
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_send requires operator or agent principal",
      );
    }
    const ext = subagentRuntimeExtensionRef.current;
    if (!ext) {
      throw new IntegrationOpError(
        "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
        "session_send requires messaging runtime",
      );
    }
    const { sessions } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const sessionId = resolveSessionSendTargetSessionId(pl, ctx.config, ctx.sessions);
    assertAgentMayTargetSessionForSendOrList(principal, sessionId, ctx.config);
    const message = requireString(pl, "message");
    const silent = pl.silent === true;
    const row = sessions.getById(sessionId);
    if (!row || row.status === "terminated") {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
    }
    if (row.subagentMode === "one_shot") {
      throw new IntegrationOpError(
        "ERR_SUBAGENT_ONE_SHOT",
        "one_shot subagents cannot receive session_send",
      );
    }
    const platformUserIdRaw = pl.platform_user_id;
    const platformUserId =
      typeof platformUserIdRaw === "string" && platformUserIdRaw.trim()
        ? platformUserIdRaw.trim()
        : undefined;
    const replyToMessageId =
      typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
        ? pl.reply_to_message_id.trim()
        : undefined;
    const delivery = silent
      ? ({ kind: "internal" } as const)
      : (() => {
          if (!platformUserId && !row.subagentPlatformThreadId?.trim()) {
            throw new IntegrationOpError(
              "ERR_MISSING_PLATFORM_USER_ID",
              "platform_user_id is required for messaging_surface delivery",
            );
          }
          return {
            kind: "messaging_surface",
            userId: platformUserId ?? "system",
            replyToMessageId,
          } as const;
        })();
    const senderSessionId =
      principal.kind === "agent" ? principal.sessionId : `operator:${principal.operatorId}`;
    const bannerText = buildSessionMessageTurnBanner({ senderSessionId });
    const turnInput: Parameters<typeof ext.runSessionModelTurn>[0] = {
      sessionId,
      userContent: message,
      userMetadata: { session_send: true },
      systemContext: {
        kind: "session.message",
        summary: `Message from session ${senderSessionId}.`,
        data: { sender_session_id: senderSessionId },
      },
      delivery,
    };
    if (optionalBooleanFlag(pl, "wait") === false) {
      // wait:false — return as soon as the message is handed off. The turn
      // keeps running detached; its outcome reaches the operator through
      // the normal delivery surface and failures land in the daemon log.
      void (async () => {
        const bannerHandle =
          delivery.kind === "internal"
            ? await ext.oobTurnBanner?.begin({
                sessionId,
                processing: bannerText.processing,
              })
            : undefined;
        try {
          const turn = await ext.runSessionModelTurn({
            ...turnInput,
            ...(bannerHandle ? { statusBarSink: bannerHandle } : {}),
          });
          if (bannerHandle) {
            await ext.oobTurnBanner?.finish({
              handle: bannerHandle,
              terminal: bannerText.terminal("finished"),
              ...(turn.statusBarLine ? { statusBar: turn.statusBarLine } : {}),
            });
          }
        } catch (err) {
          ioLog.warn("subagent conversation: send detached turn failed", {
            sessionId,
            err: String(err),
          });
        }
      })();
      ctx.recordIntegrationAudit({
        action: "session.send",
        resource: sessionId,
        outcome: "delivered",
        argsRedactedJson: JSON.stringify({ silent, wait: false }),
      });
      return { delivered: true, session_id: sessionId };
    }
    const bannerHandle =
      delivery.kind === "internal"
        ? await ext.oobTurnBanner?.begin({
            sessionId,
            processing: bannerText.processing,
          })
        : undefined;
    const turn = await ext.runSessionModelTurn({
      ...turnInput,
      ...(bannerHandle ? { statusBarSink: bannerHandle } : {}),
    });
    if (bannerHandle) {
      await ext.oobTurnBanner?.finish({
        handle: bannerHandle,
        terminal: bannerText.terminal("finished"),
        ...(turn.statusBarLine ? { statusBar: turn.statusBarLine } : {}),
      });
    }
    ctx.recordIntegrationAudit({
      action: "session.send",
      resource: sessionId,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({ silent }),
    });
    return {
      reply: turn.latestAssistantText,
      failover: turn.failoverMeta ?? null,
    };
  }
}

/**
 * Handle session_steer control operation.
 */
export async function handleSessionSteer(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    ioLog.debug("subagent conversation: steer", {
      op: req.op,
      principalKind: principal.kind,
    });
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_steer requires operator or agent principal",
      );
    }
    if (principal.kind === "agent") {
      assertAgentMayUseSubagentSessionOps(principal, ctx);
    }
    const ext = subagentRuntimeExtensionRef.current;
    if (!ext) {
      throw new IntegrationOpError(
        "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
        "subagent runtime not configured (start messaging platform)",
      );
    }
    const { sessions } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    const prompt = requireString(pl, "prompt");
    const row = sessions.getById(sessionId);
    if (!row || row.status === "terminated") {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
    }
    if (principal.kind === "agent" && row.parentSessionId !== principal.sessionId) {
      throw new IntegrationOpError("ERR_FORBIDDEN", "agent may only steer direct child subagents");
    }
    // --- Split path: inject directly into active tool loop if one exists ---
    // A channel can exist without a live turn for a few ticks (turn
    // teardown vs. session termination race). A steer pushed into such a
    // channel is dropped by the next channel teardown and — via the wait
    // path's fallback — can resurface as a stray turn on another session
    // (the stale-steer bounce). If the row is gone, fail fast here instead
    // of pushing into a channel owned by no live loop.
    if (pushSteer(sessionId, prompt)) {
      const steeredRow = sessions.getById(sessionId);
      if (!steeredRow || steeredRow.status === "terminated") {
        ioLog.warn("session_steer refused: target terminated (channel race)", {
          sessionId,
        });
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
      }
      ctx.recordIntegrationAudit({
        action: "session.steer",
        resource: sessionId,
        outcome: "injected",
      });
      return { injected: true };
    }
    const platformUserIdRaw = pl.platform_user_id;
    const platformUserId =
      typeof platformUserIdRaw === "string" && platformUserIdRaw.trim()
        ? platformUserIdRaw.trim()
        : undefined;
    const replyToMessageId =
      typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
        ? pl.reply_to_message_id.trim()
        : undefined;
    const hasThreadBinding = Boolean(row.subagentPlatformThreadId?.trim());
    const delivery =
      pl.delivery === "internal" || (!hasThreadBinding && pl.delivery !== "messaging_surface")
        ? ({ kind: "internal" } as const)
        : (() => {
            if (!platformUserId && !hasThreadBinding) {
              throw new IntegrationOpError(
                "ERR_MISSING_PLATFORM_USER_ID",
                "platform_user_id is required for messaging_surface delivery",
              );
            }
            return {
              kind: "messaging_surface",
              userId: platformUserId ?? "system",
              replyToMessageId,
            } as const;
          })();
    const senderInfo =
      principal.kind === "agent" ? principal.sessionId : `operator:${principal.operatorId}`;
    // The steer fell through to a new turn (no active tool loop to inject
    // it mid-turn). Carry the steer banner on the turn so its output
    // surface shows the directive before the model output instead of an
    // unattributed reply (visual context is otherwise lost).
    const turnInput: Parameters<typeof ext.runSessionModelTurn>[0] = {
      sessionId,
      userContent: prompt,
      userMetadata: { session_steer: true },
      turnBanner: buildSteerBanner(prompt),
      systemContext: {
        kind: "session.steer",
        summary: "Operator steering directive. Adjust your behavior accordingly.",
        data: { steered_by: senderInfo },
      },
      delivery,
    };
    if (optionalBooleanFlag(pl, "wait") === false) {
      // wait:false — deliver the directive and return immediately; the
      // detached turn's outcome reaches the operator via the delivery
      // surface and failures land in the daemon log.
      if (await assertDeliveryTargetNotTerminated(sessionId, ioLog)) {
        void ext.runSessionModelTurn(turnInput).catch((err) => {
          ioLog.warn("subagent conversation: steer detached turn failed", {
            sessionId,
            err: String(err),
          });
        });
      }
      ctx.recordIntegrationAudit({
        action: "session.steer",
        resource: sessionId,
        outcome: "delivered",
      });
      return { delivered: true, session_id: sessionId };
    }
    if (!(await assertDeliveryTargetNotTerminated(sessionId, ioLog))) {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
    }
    const turn = await ext.runSessionModelTurn(turnInput);
    ctx.recordIntegrationAudit({
      action: "session.steer",
      resource: sessionId,
      outcome: "ok",
    });
    return {
      reply: turn.latestAssistantText,
      failover: turn.failoverMeta ?? null,
    };
  }
}

/**
 * Handle session_abort control operation.
 */
export async function handleSessionAbort(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_abort requires operator or agent principal",
      );
    }
    const { sessions } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    const row = sessions.getById(sessionId);
    if (!row || row.status === "terminated") {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
    }
    if (principal.kind === "agent") {
      assertAgentMayUseSubagentSessionOps(principal, ctx);
      const own = sessionId === principal.sessionId;
      const directChild = row.parentSessionId === principal.sessionId;
      if (!own && !directChild) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "agent may only abort own session or a direct child subagent",
        );
      }
    }
    const hadActiveTurn = requestSessionTurnAbort(sessionId);
    ctx.recordIntegrationAudit({
      action: "session.abort",
      resource: sessionId,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({ had_active_turn: hadActiveTurn }),
    });
    return { ok: true, had_active_turn: hadActiveTurn };
  }
}

/**
 * Handle session_kill control operation.
 */
export async function handleSessionKill(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator" && principal.kind !== "agent") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_kill requires operator or agent principal",
      );
    }
    const { sessions, sessionManager } = requireSubagentRuntime(ctx);
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    const targetRow = sessions.getById(sessionId);
    // Platform `/close` guard: the command may only reap subagent sessions.
    // A known row without a parent is a top-level agent session (its
    // durability comes from being bound to a platform channel) — killing it
    // from a messaging surface would orphan the agent, so refuse with a
    // warning instead. Unknown rows fall through to the idempotent kill.
    if (pl.subagent_only === true && targetRow && !targetRow.parentSessionId) {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        `refusing to kill top-level agent session ${sessionId}: close targets subagent sessions only`,
      );
    }
    if (principal.kind === "agent") {
      assertAgentMayUseSubagentSessionOps(principal, ctx);
      if (!targetRow || targetRow.status === "terminated") {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
      }
      if (targetRow.parentSessionId !== principal.sessionId) {
        throw new IntegrationOpError("ERR_FORBIDDEN", "agent may only kill direct child subagents");
      }
    }
    const shouldAnnounceKilled =
      targetRow &&
      targetRow.status !== "terminated" &&
      targetRow.subagentMode === "persistent" &&
      Boolean(targetRow.subagentPlatformThreadId?.trim());
    terminatePersistentSubagentSession(
      sessionManager,
      sessionId,
      shouldAnnounceKilled ? "killed" : undefined,
      ctx.hitlClear?.autoApproveGate,
      "session_kill_op",
    );
    // Killing a session must not leave a wedged running entry or a queued
    // backlog behind: clear any queued turns and force-release the running
    // slot so the queue does not stay blocked on a dead session. The queue
    // may not be initialized (e.g. tests), so swallow any error.
    try {
      const turnQueue = getTurnQueue();
      turnQueue.clear(sessionId);
      turnQueue.forceReleaseRunning(sessionId, "session_kill");
    } catch {
      /* turn queue not initialized */
    }
    ctx.recordIntegrationAudit({
      action: "session.kill",
      resource: sessionId,
      outcome: "ok",
    });
    return { ok: true };
  }
}

/**
 * Handle session_model control operation.
 */
export async function handleSessionModel(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator") {
      throw new IntegrationOpError("ERR_FORBIDDEN", "session_model requires operator principal");
    }
    if (!ctx.stateDb || !ctx.sessions) {
      throw new IntegrationOpError(
        "ERR_STATE_DB_REQUIRED",
        "session_model requires state database",
      );
    }
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    const row = ctx.sessions.getById(sessionId);
    if (!row) {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session not found");
    }
    const hasSelection = "model_selection" in pl;
    if (hasSelection) {
      const val = pl.model_selection;
      if (val != null && typeof val === "object" && !Array.isArray(val)) {
        const m = (val as Record<string, unknown>).model;
        if (typeof m === "string") {
          const slashIdx = m.indexOf("/");
          if (slashIdx < 1 || slashIdx === m.length - 1) {
            throw new IntegrationOpError(
              "ERR_INVALID_PAYLOAD",
              "model_selection.model must be in providerId/model format",
            );
          }
        }
      }

      // Model-switch guards (mid-turn AND idle). Only apply when the new
      // selection actually changes the session's primary model ref: an
      // invocation-only tweak (no `model`) or re-selecting the current
      // model is always allowed.
      const effective = resolveEffectiveModelsConfig(ctx.config, sessionId) ?? ctx.config.models;
      const previousRef =
        getSessionPrimaryModelRef(row.modelSelection) ??
        (typeof effective?.failoverChain?.[0] === "string"
          ? effective.failoverChain[0]
          : undefined);
      const requestedRef = getSessionPrimaryModelRef(val);
      if (requestedRef && requestedRef !== previousRef) {
        // Compatibility guard: the ref must resolve in the session's
        // effective models config (same tool-calling interface — every
        // configured provider serves completeWithTools), otherwise the
        // daemon could not serve it.
        const exists = validateModelRefExists(effective, requestedRef);
        if (!exists.ok) {
          throw new IntegrationOpError("ERR_MODEL_NOT_FOUND", exists.error);
        }
        // Context window for a "providerId/model" ref: metadata store
        // first (provider-reported/default), effective config as fallback.
        const lookupWindow = (ref: string): number | undefined => {
          const { providerId, modelName } = splitModelRef(ref);
          return (
            getModelContextWindowTokens(providerId, modelName) ??
            modelProvidersToEntries(effective?.providers).find((pr) => pr.id === providerId)
              ?.models?.[modelName]?.contextWindowTokens
          );
        };
        // Context-window guard: the new model's window must be large
        // enough for the session's estimated context usage, else the
        // session would overflow it.
        const newWindow = lookupWindow(requestedRef);
        const estimatedUsage = ctx.stateDb
          ? getContextFill(ctx.stateDb, sessionId, row.contextSegmentId)
          : 0;
        if (newWindow != null && estimatedUsage > newWindow) {
          throw new IntegrationOpError(
            "ERR_CONTEXT_WINDOW_TOO_SMALL",
            `model "${requestedRef}" has a context window of ${newWindow} tokens, smaller than the session's estimated context usage of ${estimatedUsage} tokens`,
          );
        }
        // Cap-reduction warning: the switch is allowed but reduces the
        // context window cap — tell the user through the banner system.
        const oldWindow = previousRef ? lookupWindow(previousRef) : undefined;
        if (newWindow != null && oldWindow != null && newWindow < oldWindow) {
          notifyModelSwitchCapReduced(sessionId, requestedRef, newWindow, oldWindow);
        }
      }

      const modelSelection = val === null ? undefined : val;
      ctx.sessions.update(sessionId, {
        modelSelection: modelSelection ?? null,
      });
      const updated = ctx.sessions.getById(sessionId);
      if (requestedRef && requestedRef !== previousRef) {
        // Notify the live turn when a mid-turn switch takes effect: this
        // folds into the in-flight turn's output, and is a no-op when the
        // session is idle (the next turn simply starts on the new model).
        postTurnSurfaceNotice(
          sessionId,
          `> 🔄 Model switch applied mid-turn: \`${requestedRef}\` serves the next round`,
        );
      }
      return {
        ok: true,
        session_id: sessionId,
        model_selection: updated?.modelSelection ?? null,
        effective_models: resolveEffectiveModelsConfig(ctx.config, sessionId) ?? null,
      };
    }
    const effective = resolveEffectiveModelsConfig(ctx.config, sessionId) ?? null;
    return {
      ok: true,
      session_id: sessionId,
      model_selection: row.modelSelection ?? null,
      effective_models: effective,
    };
  }
}

/**
 * Handle session_queue_manage control operation.
 */
export async function handleSessionQueueManage(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  {
    if (principal.kind !== "operator") {
      throw new IntegrationOpError(
        "ERR_FORBIDDEN",
        "session_queue_manage requires operator principal",
      );
    }
    const pl = payloadObject(req);
    const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);
    const action = requireString(pl, "action");
    const priorityRaw = pl.priority;
    const priority = priorityRaw === "system" || priorityRaw === "user" ? priorityRaw : undefined;
    const priorityOrAll = priority ?? "all";

    let queue: import("../sessions/session-turn-queue").TieredTurnQueue;
    try {
      queue = getTurnQueue();
    } catch {
      throw new IntegrationOpError("ERR_QUEUE_UNAVAILABLE", "turn queue not initialized");
    }

    // Queue indexes are 1-based on the wire: `list` numbers entries from 1
    // and `remove` accepts 1-based index/start/end bounds. Markdown
    // renderers (e.g. Discord) always start numbered lists at 1, so 0-based
    // output would desync from what the operator actually sees.
    if (action === "list") {
      const entries = queue.listQueued(sessionId, priority).map((e, i) => ({
        id: e.id,
        priority: e.priority,
        label: e.label,
        enqueuedAt: e.enqueuedAt,
        index: i + 1,
      }));
      return { entries, running: queue.getRunning(sessionId) ?? null };
    }

    if (action === "clear") {
      const removed = queue.clear(sessionId, priority);
      return { removed };
    }

    if (action === "release") {
      const released = queue.forceReleaseRunning(sessionId);
      return { released, running: queue.getRunning(sessionId) ?? null };
    }

    if (action === "remove") {
      const by = pl.by;
      if (by === "index") {
        const idx = pl.index;
        if (!isNumberAtLeast(idx, 1)) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "payload.index must be a number >= 1 (1-based, matching list output)",
          );
        }
        const removed = queue.removeByRange(sessionId, priorityOrAll, idx - 1, idx - 1);
        return { removed };
      }
      if (by === "range") {
        const start = pl.start;
        const end = pl.end;
        if (!isNumberAtLeast(start, 1) || !isNumberAtLeast(end, 1)) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "payload.start and payload.end must be numbers >= 1 (1-based, matching list output)",
          );
        }
        const removed = queue.removeByRange(sessionId, priorityOrAll, start - 1, end - 1);
        return { removed };
      }
      if (by === "count") {
        const count = pl.count;
        if (!isNumberAtLeast(count, 1)) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "payload.count must be a positive number",
          );
        }
        const removed = queue.removeByCount(sessionId, priorityOrAll, count);
        return { removed };
      }
      throw new IntegrationOpError(
        "ERR_INVALID_PAYLOAD",
        "payload.by must be index, range, or count",
      );
    }

    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.action must be list, remove, clear, or release",
    );
  }
}
