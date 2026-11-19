/**
 * Control plane HITL operations (pending approvals, clear, cruise control).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { CruiseControlPolicy, ShoggothConfig } from "@shoggoth/shared";
import { assertValidAgentId, loadLayeredConfigAsync, parseAgentSessionUrn } from "@shoggoth/shared";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import { cruiseControlActivationWarnings } from "../hitl/cruise-control";
import {
  readAgentToolAutoApproveMap,
  rewriteAgentToolAutoApproveMapAndReload,
} from "../hitl/hitl-agent-tool-auto-persist";
import {
  clearAllSessionToolAutoApprove,
  clearSessionToolAutoApproveForSessionIds,
} from "../hitl/hitl-session-tool-auto-store";
import type { SessionStore } from "../sessions/session-store";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";
import { resolveSessionTargetFromCliArg } from "./resolve-session-cli-target";

function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      `payload.${key} must be a non-empty string`,
    );
  }
  return v;
}

function optionalNonEmptySessionId(pl: Record<string, unknown>): string | undefined {
  const v = pl.session_id;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.session_id must be a non-empty string when provided",
    );
  }
  return v.trim();
}

function resolveTargetSessionIdOrThrow(
  raw: string,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  try {
    return resolveSessionTargetFromCliArg(raw, cfg, sessions);
  } catch (e) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", e instanceof Error ? e.message : String(e));
  }
}

function requireSessionId(
  pl: Record<string, unknown>,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string {
  return resolveTargetSessionIdOrThrow(requireString(pl, "session_id"), cfg, sessions);
}

/** Like {@link requireSessionId}, but returns undefined when `payload.session_id` is absent. */
function optionalSessionId(
  pl: Record<string, unknown>,
  cfg: ShoggothConfig,
  sessions: SessionStore | undefined,
): string | undefined {
  const raw = optionalNonEmptySessionId(pl);
  if (raw === undefined) return undefined;
  return resolveTargetSessionIdOrThrow(raw, cfg, sessions);
}

/** Action names accepted by the HITL audit recorder for pending-op audit rows. */
type HitlPendingAuditAction = "hitl.pending_approve" | "hitl.pending_deny";

/** Per-op identity for {@link hitlPendingOp}: wire op name, audit action, store mutation. */
interface HitlPendingOpIdentity {
  readonly opName: string;
  readonly action: HitlPendingAuditAction;
  readonly resolve: (store: PendingActionsStore, id: string, operatorId: string) => boolean;
}

/**
 * Operator guard + payload resolution + decision + audit shared by
 * `hitl_pending_approve` and `hitl_pending_deny`: principal check
 * (op-specific error string), pending store availability, `payload.id`
 * extraction, the per-op store mutation, and the per-op audit row.
 */
async function hitlPendingOp(
  identity: HitlPendingOpIdentity,
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", `${identity.opName} requires operator principal`);
  }
  if (!ctx.hitlPending) {
    throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
  }
  const pl = payloadObject(req);
  const id = requireString(pl, "id");
  const ok = identity.resolve(ctx.hitlPending, id, principal.operatorId);
  ctx.recordIntegrationAudit({
    action: identity.action,
    resource: id,
    outcome: ok ? "ok" : "not_pending",
  });
  return { ok };
}

/**
 * Handle hitl_pending_list control operation.
 */
export async function handleHitlPendingList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_pending_list requires operator principal");
  }
  if (!ctx.hitlPending) {
    throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
  }
  const pl = payloadObject(req);
  const sessionId = optionalSessionId(pl, ctx.config, ctx.sessions);
  if (sessionId) {
    return { pending: ctx.hitlPending.listPendingForSession(sessionId) };
  }
  const limitRaw = pl.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : undefined;
  return { pending: ctx.hitlPending.listAllPending(limit) };
}

/**
 * Handle hitl_pending_get control operation.
 */
export async function handleHitlPendingGet(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_pending_get requires operator principal");
  }
  if (!ctx.hitlPending) {
    throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
  }
  const pl = payloadObject(req);
  const id = requireString(pl, "id");
  const row = ctx.hitlPending.getById(id);
  return { row: row ?? null };
}

/**
 * Handle hitl_pending_approve control operation.
 */
export async function handleHitlPendingApprove(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  return hitlPendingOp(
    {
      opName: "hitl_pending_approve",
      action: "hitl.pending_approve",
      resolve: (store, id, operatorId) => store.approve(id, operatorId),
    },
    req,
    principal,
    ctx,
  );
}

/**
 * Handle hitl_pending_deny control operation.
 */
export async function handleHitlPendingDeny(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  return hitlPendingOp(
    {
      opName: "hitl_pending_deny",
      action: "hitl.pending_deny",
      resolve: (store, id, operatorId) => store.deny(id, operatorId),
    },
    req,
    principal,
    ctx,
  );
}

/** Resolved `hitl_clear` request: target agent, optional session, auto-clear flag. */
interface HitlClearRequest {
  readonly agentId: string;
  readonly sessionId: string | undefined;
  readonly noAuto: boolean;
  readonly skipAutoClear: boolean;
}

/** Per-phase counts returned by the clear phases and folded into the result. */
interface HitlClearAutoResult {
  readonly clearedSessionAutoApprove: number;
  readonly clearedAgentAutoApproveAgents: number;
}

/** Validate `payload.agent_id` (verbatim semantics; `all` bypasses validation). */
function parseHitlClearAgentId(pl: Record<string, unknown>): string {
  const agentIdRaw = requireString(pl, "agent_id").trim();
  if (agentIdRaw !== "all") {
    assertValidAgentId(agentIdRaw);
  }
  return agentIdRaw;
}

/**
 * Resolve the sessions targeted by `hitl_clear` (verbatim semantics): an
 * explicit `session_id` validates against the agent and must be live; `all`
 * targets every session; otherwise the agent's own sessions.
 */
function resolveHitlClearSessionIds(
  ctx: IntegrationOpsContext,
  parsedReq: HitlClearRequest,
): string[] {
  const { agentId, sessionId } = parsedReq;
  const sessions = ctx.sessions;
  if (!sessions) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "hitl_clear requires SQLite session store",
    );
  }
  if (sessionId) {
    const parsed = parseAgentSessionUrn(sessionId);
    if (!parsed) {
      throw new IntegrationOpError(
        "ERR_INVALID_PAYLOAD",
        "payload.session_id must be a valid agent session URN",
      );
    }
    if (agentId !== "all" && parsed.agentId !== agentId) {
      throw new IntegrationOpError(
        "ERR_INVALID_PAYLOAD",
        "payload.session_id agent does not match payload.agent_id",
      );
    }
    const row = sessions.getById(sessionId);
    if (!row) {
      throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
    }
    return [sessionId];
  }
  if (agentId === "all") {
    return sessions.list().map((r) => r.id);
  }
  return sessions.list({ agentId }).map((r) => r.id);
}

/**
 * Wipe auto-approve state for a `hitl_clear` target (verbatim semantics):
 * SQLite session rows, the agent-tool auto-approve map on disk (with config
 * reload), and the in-memory gate entries.
 */
async function clearHitlAutoApprove(
  ctx: IntegrationOpsContext,
  parsedReq: HitlClearRequest,
  sessionIds: string[],
): Promise<HitlClearAutoResult> {
  const { agentId, skipAutoClear } = parsedReq;
  let clearedSessionAutoApprove = 0;
  let clearedAgentAutoApproveAgents = 0;
  if (skipAutoClear) return { clearedSessionAutoApprove, clearedAgentAutoApproveAgents };
  const stateDb = ctx.stateDb;
  if (!stateDb) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "hitl_clear requires SQLite session store",
    );
  }
  const hc = ctx.hitlClear;
  if (!hc) {
    throw new IntegrationOpError(
      "ERR_HITL_UNAVAILABLE",
      "HITL auto-approve clear not configured (requires persisting HITL gate)",
    );
  }
  if (agentId === "all") {
    clearedSessionAutoApprove = clearAllSessionToolAutoApprove(stateDb);
  } else {
    clearedSessionAutoApprove = clearSessionToolAutoApproveForSessionIds(stateDb, sessionIds);
  }
  const merged = readAgentToolAutoApproveMap(await loadLayeredConfigAsync(hc.configDirectory));
  const nextMap: Record<string, string[]> =
    agentId === "all"
      ? Object.fromEntries(Object.keys(merged).map((k) => [k, [] as string[]]))
      : { ...merged, [agentId]: [] };
  if (hc.dynamicConfigDirectory) {
    await rewriteAgentToolAutoApproveMapAndReload({
      configDirectory: hc.configDirectory,
      dynamicConfigDirectory: hc.dynamicConfigDirectory,
      configRef: hc.configRef,
      hitlRef: hc.hitlRef,
      nextAgentToolAutoApprove: nextMap,
    });
  }
  clearedAgentAutoApproveAgents = agentId === "all" ? Object.keys(merged).length : 1;
  if (agentId === "all") {
    hc.autoApproveGate.clearAutoApproveMemory?.({ agents: "all" });
  } else {
    hc.autoApproveGate.clearAutoApproveMemory?.({ agents: [agentId] });
  }
  return { clearedSessionAutoApprove, clearedAgentAutoApproveAgents };
}

/**
 * Handle hitl_clear control operation.
 */
export async function handleHitlClear(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_clear requires operator principal");
  }
  if (!ctx.hitlPending) {
    throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
  }
  if (!ctx.stateDb || !ctx.sessions) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "hitl_clear requires SQLite session store",
    );
  }
  const pl = payloadObject(req);
  const agentIdRaw = parseHitlClearAgentId(pl);
  const sessionIdOpt = optionalSessionId(pl, ctx.config, ctx.sessions);
  const noAuto = pl.no_auto === true;
  /** Session-scoped clear never touches auto-approve (SQLite / z-JSON / memory). */
  const parsedReq: HitlClearRequest = {
    agentId: agentIdRaw,
    sessionId: sessionIdOpt,
    noAuto,
    skipAutoClear: Boolean(sessionIdOpt) || noAuto,
  };

  const sessionIds = resolveHitlClearSessionIds(ctx, parsedReq);
  const deletedPending = ctx.hitlPending.deletePendingForSessionIds(sessionIds);
  const autoResult = await clearHitlAutoApprove(ctx, parsedReq, sessionIds);

  ctx.recordIntegrationAudit({
    action: "hitl.clear",
    resource: sessionIdOpt ?? agentIdRaw,
    outcome: "ok",
    argsRedactedJson: JSON.stringify({
      agent_id: agentIdRaw,
      session_id: sessionIdOpt,
      no_auto: noAuto,
    }),
  });

  return {
    deleted_pending: deletedPending,
    session_ids: sessionIds,
    cleared_session_auto_approve: autoResult.clearedSessionAutoApprove,
    cleared_agent_auto_approve_agents: autoResult.clearedAgentAutoApproveAgents,
  };
}

/**
 * Handle hitl_cruise_control control operation.
 */
export async function handleHitlCruiseControl(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "hitl_cruise_control requires operator principal",
    );
  }
  if (!ctx.cruiseControl) {
    throw new IntegrationOpError("ERR_CRUISE_UNAVAILABLE", "cruise control not configured");
  }
  const pl = payloadObject(req);
  const sessionId = requireSessionId(pl, ctx.config, ctx.sessions);

  if (pl.deactivate === true) {
    const cleared = ctx.cruiseControl.clear(sessionId);
    ctx.recordIntegrationAudit({
      action: "hitl.cruise_deactivate",
      resource: sessionId,
      outcome: cleared ? "ok" : "not_active",
    });
    return { active: false, cleared };
  }

  const yes = typeof pl.yes === "string" ? pl.yes.trim() : "";
  const no = typeof pl.no === "string" ? pl.no.trim() : "";
  if (!yes || !no) {
    // No guidance provided — status query.
    const policy = ctx.cruiseControl.get(sessionId);
    return {
      active: policy !== undefined,
      policy: policy ?? null,
      warnings: policy ? cruiseControlActivationWarnings(ctx.config, policy) : [],
    };
  }

  const escalate =
    typeof pl.escalate === "string" && pl.escalate.trim() ? pl.escalate.trim() : undefined;
  const model = typeof pl.model === "string" && pl.model.trim() ? pl.model.trim() : undefined;
  const policy: CruiseControlPolicy = {
    yes,
    no,
    ...(escalate ? { escalate } : {}),
    ...(model ? { model } : {}),
  };
  const warnings = cruiseControlActivationWarnings(ctx.config, policy);
  ctx.cruiseControl.set(sessionId, policy);
  ctx.recordIntegrationAudit({
    action: "hitl.cruise_activate",
    resource: sessionId,
    outcome: "ok",
    argsRedactedJson: JSON.stringify({
      yes,
      no,
      escalate: escalate ?? null,
      model: model ?? null,
    }),
  });
  return { active: true, policy, warnings };
}
