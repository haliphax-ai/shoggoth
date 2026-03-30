import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  assertValidAgentId,
  crossAgentSessionSendAllowed,
  parseAgentSessionUrn,
} from "@shoggoth/shared";
import {
  authorizeCanvasAction,
  type CanvasAuthzAction,
  createAcpxBinding,
  SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV,
  SHOGGOTH_CONTROL_SOCKET_ENV,
  SHOGGOTH_SESSION_ID_ENV,
} from "@shoggoth/mcp-integration";
import type { AppendAuditRowInput } from "../audit/append-audit";
import type { AcpxProcessSupervisor } from "../acpx/acpx-process-supervisor";
import { AcpxSupervisorError } from "../acpx/acpx-process-supervisor";
import type { AcpxBindingStore } from "../acpx/sqlite-acpx-bindings";
import { SessionManagerError, type SessionManager } from "../sessions/session-manager";
import type { SessionRow, SessionStore } from "../sessions/session-store";
import { resolveSessionTargetFromCliArg } from "./resolve-session-cli-target";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../sessions/session-context-segment";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import { mergeSubagentSpawnModelSelection } from "@shoggoth/models";
import { dispatchMcpHttpCancelRequest } from "../mcp/mcp-http-cancel-registry";
import { SUBAGENT_DEFAULT_BOUND_LIFETIME_MS } from "../subagent/subagent-constants";
import { requestSessionTurnAbort } from "../sessions/session-turn-abort";
import { disposeSubagentRuntime, rememberSubagentHandles } from "../subagent/subagent-disposables";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { terminateBoundSubagentSession } from "../subagent/subagent-kill";

export class IntegrationOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationOpError";
  }
}

const CANVAS_ACTIONS: ReadonlySet<string> = new Set([
  "canvas.present",
  "canvas.push",
  "canvas.navigate",
]);

export type IntegrationAuditRecorder = (
  row: Pick<AppendAuditRowInput, "action" | "resource" | "outcome" | "argsRedactedJson">,
) => void;

export type IntegrationOpsContext = {
  readonly config: ShoggothConfig;
  /** SQLite handle for transcript deletes and other stateful integration ops. */
  readonly stateDb: Database.Database | undefined;
  readonly acpxStore: AcpxBindingStore | undefined;
  readonly sessions: SessionStore | undefined;
  readonly sessionManager: SessionManager | undefined;
  readonly acpxSupervisor: AcpxProcessSupervisor | undefined;
  readonly recordIntegrationAudit: IntegrationAuditRecorder;
  /** When unset, HITL control ops return ERR_HITL_UNAVAILABLE. */
  readonly hitlPending?: PendingActionsStore;
  /**
   * MCP streamable HTTP cancel routing (default: process registry filled by Discord platform).
   * Override in tests.
   */
  readonly cancelMcpHttpRequest?: (input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly requestId: number;
  }) => boolean;
};

function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

function optionalRecordObject(
  pl: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = pl[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a non-empty string`);
  }
  return v;
}

function optionalFinitePositiveInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a finite number`);
  }
  const n = Math.trunc(v);
  if (n < 1) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be positive`);
  }
  return n;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be an array of strings`);
  }
  return v as string[];
}

function mapSessionListRow(row: SessionRow) {
  return {
    id: row.id,
    status: row.status,
    workspace_path: row.workspacePath,
    context_segment_id: row.contextSegmentId,
    parent_session_id: row.parentSessionId ?? null,
    subagent_mode: row.subagentMode ?? null,
    subagent_discord_thread_id: row.subagentDiscordThreadId ?? null,
    subagent_expires_at_ms: row.subagentExpiresAtMs ?? null,
    light_context: row.lightContext,
  };
}

/** Resolve target session id from `session_id` or bootstrap main session for `agent_id`. */
function resolveSessionSendTargetSessionId(pl: Record<string, unknown>, cfg: ShoggothConfig): string {
  const sidRaw = pl.session_id;
  const aidRaw = pl.agent_id;
  const hasSid = typeof sidRaw === "string" && sidRaw.trim();
  const hasAid = typeof aidRaw === "string" && aidRaw.trim();
  if (hasSid && hasAid) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload must not set both session_id and agent_id",
    );
  }
  if (hasSid) return (sidRaw as string).trim();
  if (hasAid) {
    return resolveSessionTargetFromCliArg((aidRaw as string).trim(), cfg);
  }
  throw new IntegrationOpError(
    "ERR_INVALID_PAYLOAD",
    "payload.session_id or payload.agent_id is required",
  );
}

/**
 * Agents may `session_send` to their own agent's sessions always; cross-agent sends require
 * Top-level `agentToAgent.allow` plus optional per-agent `agents.list.<id>.agentToAgent.allow`.
 */
function assertAgentMayTargetSessionForSendOrList(
  principal: AuthenticatedPrincipal,
  targetSessionId: string,
  config: ShoggothConfig,
): void {
  if (principal.kind !== "agent") return;
  const callerAgentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
  const targetAgentId = parseAgentSessionUrn(targetSessionId)?.agentId;
  if (!callerAgentId || !targetAgentId) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "agent session_send requires valid agent session URNs for caller and target",
    );
  }
  if (!crossAgentSessionSendAllowed(config, callerAgentId, targetAgentId)) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "cross-agent session_send denied (configure agentToAgent.allow and/or agents.list.<id>.agentToAgent.allow)",
    );
  }
}

function requireSubagentRuntime(ctx: IntegrationOpsContext): {
  sessions: NonNullable<IntegrationOpsContext["sessions"]>;
  sessionManager: NonNullable<IntegrationOpsContext["sessionManager"]>;
} {
  if (!ctx.stateDb || !ctx.sessions || !ctx.sessionManager) {
    throw new IntegrationOpError(
      "ERR_STATE_DB_REQUIRED",
      "subagent ops require SQLite state and session manager",
    );
  }
  return { sessions: ctx.sessions, sessionManager: ctx.sessionManager };
}

/** Top-level agents may spawn subagents under their own session id only; nested subagents may not spawn. */
function assertAgentMayUseSubagentSpawn(
  principal: AuthenticatedPrincipal,
  parentSessionId: string,
  sessions: SessionStore,
): void {
  if (principal.kind !== "agent") return;
  if (principal.sessionId !== parentSessionId) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "agent may only spawn subagents with parent_session_id equal to own session",
    );
  }
  const row = sessions.getById(principal.sessionId);
  if (!row || row.status === "terminated") {
    throw new IntegrationOpError(
      "ERR_PARENT_SESSION_INVALID",
      "parent session is missing or terminated",
    );
  }
  if (row.parentSessionId) {
    throw new IntegrationOpError(
      "ERR_SUBAGENT_NESTING_FORBIDDEN",
      "subagents cannot spawn nested subagents",
    );
  }
}

function requireAcpxRuntime(ctx: IntegrationOpsContext): {
  acpxStore: AcpxBindingStore;
  sessions: SessionStore;
  sessionManager: SessionManager;
  acpxSupervisor: AcpxProcessSupervisor;
} {
  if (!ctx.acpxStore) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
  }
  if (!ctx.sessions || !ctx.sessionManager || !ctx.acpxSupervisor) {
    throw new IntegrationOpError(
      "ERR_ACPX_RUNTIME_UNAVAILABLE",
      "acpx agent lifecycle requires session store and process supervisor",
    );
  }
  return {
    acpxStore: ctx.acpxStore,
    sessions: ctx.sessions,
    sessionManager: ctx.sessionManager,
    acpxSupervisor: ctx.acpxSupervisor,
  };
}

/**
 * Control-plane handlers for ACPX workspace bindings, managed acpx processes, and canvas authorization.
 */
export async function handleIntegrationControlOp(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  switch (req.op) {
    case "acpx_bind_get": {
      if (!ctx.acpxStore) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
      }
      const pl = payloadObject(req);
      const root = requireString(pl, "acp_workspace_root");
      const hit = ctx.acpxStore.get(root);
      if (principal.kind === "agent") {
        if (!hit || hit.shoggothSessionId !== principal.sessionId) {
          return { binding: null };
        }
      }
      return { binding: hit ?? null };
    }

    case "acpx_bind_set": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_bind_set requires operator principal");
      }
      if (!ctx.acpxStore) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
      }
      const pl = payloadObject(req);
      const acpWorkspaceRoot = requireString(pl, "acp_workspace_root");
      const shoggothSessionId = requireString(pl, "shoggoth_session_id");
      const agentPrincipalId = requireString(pl, "agent_principal_id");
      const binding = createAcpxBinding({
        acpWorkspaceRoot,
        shoggothSessionId,
        agentPrincipalId,
      });
      ctx.acpxStore.upsert(binding);
      return { ok: true };
    }

    case "acpx_bind_delete": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_bind_delete requires operator principal");
      }
      if (!ctx.acpxStore) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
      }
      const pl = payloadObject(req);
      const root = requireString(pl, "acp_workspace_root");
      return { deleted: ctx.acpxStore.delete(root) };
    }

    case "acpx_bind_list": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_bind_list requires operator principal");
      }
      if (!ctx.acpxStore) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
      }
      return { bindings: ctx.acpxStore.list() };
    }

    case "acpx_agent_start": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_agent_start requires operator principal");
      }
      const rt = requireAcpxRuntime(ctx);
      const pl = payloadObject(req);
      const root = requireString(pl, "acp_workspace_root");
      const binding = rt.acpxStore.get(root);
      if (!binding) {
        throw new IntegrationOpError("ERR_ACPX_BINDING_NOT_FOUND", `no binding for workspace root ${root}`);
      }
      const session = rt.sessions.getById(binding.shoggothSessionId);
      if (!session || session.status === "terminated") {
        throw new IntegrationOpError(
          "ERR_SESSION_INACTIVE",
          "bound Shoggoth session is missing or terminated",
        );
      }
      const args = optionalStringArray(pl, "acpx_args") ?? ctx.config.acpx?.defaultArgs;
      if (!args || args.length === 0) {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          "payload.acpx_args or config.acpx.defaultArgs is required",
        );
      }
      const binary = ctx.config.acpx?.binary ?? "acpx";
      let creds;
      try {
        creds = rt.sessionManager.rotateAgentToken(binding.shoggothSessionId);
      } catch (e) {
        if (e instanceof SessionManagerError) {
          throw new IntegrationOpError(e.code, e.message);
        }
        throw e;
      }
      const env: Record<string, string> = {
        [SHOGGOTH_CONTROL_SOCKET_ENV]: ctx.config.socketPath,
        [SHOGGOTH_SESSION_ID_ENV]: binding.shoggothSessionId,
        [SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV]: root,
        [SHOGGOTH_AGENT_TOKEN_ENV]: creds.agentToken,
      };
      let pid: number;
      try {
        ({ pid } = rt.acpxSupervisor.start({
          acpWorkspaceRoot: root,
          shoggothSessionId: binding.shoggothSessionId,
          command: binary,
          args,
          cwd: root,
          env,
        }));
      } catch (e) {
        if (e instanceof AcpxSupervisorError) {
          throw new IntegrationOpError(e.code, e.message);
        }
        throw e;
      }
      ctx.recordIntegrationAudit({
        action: "acpx.agent_start",
        resource: root,
        outcome: "ok",
        argsRedactedJson: JSON.stringify({
          pid,
          shoggoth_session_id: binding.shoggothSessionId,
          binary,
        }),
      });
      return {
        ok: true,
        pid,
        shoggoth_session_id: binding.shoggothSessionId,
        acp_workspace_root: root,
      };
    }

    case "acpx_agent_stop": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_agent_stop requires operator principal");
      }
      const rt = requireAcpxRuntime(ctx);
      const pl = payloadObject(req);
      const root = requireString(pl, "acp_workspace_root");
      const { stopped, pid } = rt.acpxSupervisor.stop(root);
      ctx.recordIntegrationAudit({
        action: "acpx.agent_stop",
        resource: root,
        outcome: stopped ? "ok" : "not_running",
        argsRedactedJson: pid !== undefined ? JSON.stringify({ pid }) : undefined,
      });
      return { stopped, pid };
    }

    case "acpx_agent_list": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_agent_list requires operator principal");
      }
      const rt = requireAcpxRuntime(ctx);
      const processes = rt.acpxSupervisor.list().map((t) => ({
        pid: t.pid,
        shoggoth_session_id: t.shoggothSessionId,
        started_at_ms: t.startedAtMs,
      }));
      return { processes };
    }

    case "session_context_new": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_context_new requires operator principal");
      }
      if (!ctx.stateDb || !ctx.sessions) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session context ops require state database");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const out = applySessionContextSegmentNew({
        db: ctx.stateDb,
        sessions: ctx.sessions,
        sessionId,
        pending: ctx.hitlPending,
      });
      ctx.recordIntegrationAudit({
        action: "session.context_segment_new",
        resource: sessionId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify(out),
      });
      return out;
    }

    case "session_context_reset": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_context_reset requires operator principal");
      }
      if (!ctx.stateDb || !ctx.sessions) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session context ops require state database");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const out = applySessionContextSegmentReset({
        db: ctx.stateDb,
        sessions: ctx.sessions,
        sessionId,
        pending: ctx.hitlPending,
      });
      ctx.recordIntegrationAudit({
        action: "session.context_segment_reset",
        resource: sessionId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify(out),
      });
      return out;
    }

    case "hitl_pending_list": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_pending_list requires operator principal");
      }
      if (!ctx.hitlPending) {
        throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
      }
      const pl = payloadObject(req);
      const sessionId = pl.session_id;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return { pending: ctx.hitlPending.listPendingForSession(sessionId) };
      }
      const limitRaw = pl.limit;
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : undefined;
      return { pending: ctx.hitlPending.listAllPending(limit) };
    }

    case "hitl_pending_get": {
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

    case "hitl_pending_approve": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_pending_approve requires operator principal");
      }
      if (!ctx.hitlPending) {
        throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
      }
      const pl = payloadObject(req);
      const id = requireString(pl, "id");
      const ok = ctx.hitlPending.approve(id, principal.operatorId);
      ctx.recordIntegrationAudit({
        action: "hitl.pending_approve",
        resource: id,
        outcome: ok ? "ok" : "not_pending",
      });
      return { ok };
    }

    case "hitl_pending_deny": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_pending_deny requires operator principal");
      }
      if (!ctx.hitlPending) {
        throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
      }
      const pl = payloadObject(req);
      const id = requireString(pl, "id");
      const ok = ctx.hitlPending.deny(id, principal.operatorId);
      ctx.recordIntegrationAudit({
        action: "hitl.pending_deny",
        resource: id,
        outcome: ok ? "ok" : "not_pending",
      });
      return { ok };
    }

    case "canvas_authorize": {
      const pl = payloadObject(req);
      const resourceSessionId = requireString(pl, "resource_session_id");
      const actionRaw = requireString(pl, "action");
      if (!CANVAS_ACTIONS.has(actionRaw)) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.action must be a canvas authz action");
      }
      const action = actionRaw as CanvasAuthzAction;

      if (principal.kind === "operator") {
        return authorizeCanvasAction({
          principalKind: "operator",
          action,
          resourceSessionId,
        });
      }
      if (principal.kind === "agent") {
        return authorizeCanvasAction({
          principalKind: "agent",
          agentSessionId: principal.sessionId,
          action,
          resourceSessionId,
        });
      }
      throw new IntegrationOpError("ERR_FORBIDDEN", "canvas_authorize unsupported for this principal");
    }

    case "mcp_http_cancel_request": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "mcp_http_cancel_request requires operator principal");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const sourceId = requireString(pl, "source_id");
      const requestIdRaw = pl.request_id;
      if (typeof requestIdRaw !== "number" || !Number.isFinite(requestIdRaw)) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.request_id must be a finite number");
      }
      const requestId = Math.trunc(requestIdRaw);
      const cancel = ctx.cancelMcpHttpRequest ?? dispatchMcpHttpCancelRequest;
      const cancelled = cancel({ sessionId, sourceId, requestId });
      return { cancelled };
    }

    case "subagent_spawn": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "subagent_spawn requires operator or agent principal",
        );
      }
      const ext = subagentRuntimeExtensionRef.current;
      if (!ext) {
        throw new IntegrationOpError(
          "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
          "subagent runtime not configured (start messaging platform; Discord when enabled)",
        );
      }
      const { sessions, sessionManager } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const parentSessionId = requireString(pl, "parent_session_id");
      assertAgentMayUseSubagentSpawn(principal, parentSessionId, sessions);
      const prompt = requireString(pl, "prompt");
      const modeRaw = requireString(pl, "mode");
      if (modeRaw !== "one_shot" && modeRaw !== "bound_discord_thread") {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          "payload.mode must be one_shot or bound_discord_thread",
        );
      }
      const parent = sessions.getById(parentSessionId);
      if (!parent || parent.status === "terminated") {
        throw new IntegrationOpError(
          "ERR_PARENT_SESSION_INVALID",
          "parent session is missing or terminated",
        );
      }
      const modelOptions = optionalRecordObject(pl, "model_options");
      const modelSelection = mergeSubagentSpawnModelSelection(parent.modelSelection, modelOptions);
      let childId: string;
      try {
        ({ sessionId: childId } = sessionManager.spawn({
          parentSessionId,
          ...(modelSelection !== undefined ? { modelSelection } : {}),
        }));
      } catch (e) {
        if (e instanceof SessionManagerError) {
          throw new IntegrationOpError(e.code, e.message);
        }
        throw e;
      }
      const now = Date.now();
      if (modeRaw === "one_shot") {
        sessions.update(childId, {
          parentSessionId,
          subagentMode: "one_shot",
          subagentDiscordThreadId: null,
          subagentExpiresAtMs: null,
        });
        const turn = await ext.runSessionModelTurn({
          sessionId: childId,
          userContent: prompt,
          userMetadata: { subagent_one_shot: true, parent_session_id: parentSessionId },
          delivery: { kind: "internal" },
        });
        terminateBoundSubagentSession(sessionManager, childId);
        ctx.recordIntegrationAudit({
          action: "subagent.spawn_one_shot",
          resource: childId,
          outcome: "ok",
          argsRedactedJson: JSON.stringify({ parent_session_id: parentSessionId }),
        });
        return {
          session_id: childId,
          mode: "one_shot",
          reply: turn.latestAssistantText,
          failover: turn.failoverMeta ?? null,
        };
      }
      const discordThreadId = requireString(pl, "discord_thread_id");
      const lifetimeMs = optionalFinitePositiveInt(pl, "lifetime_ms") ?? SUBAGENT_DEFAULT_BOUND_LIFETIME_MS;
      const discordUserIdRaw = pl.discord_user_id;
      const discordUserId =
        typeof discordUserIdRaw === "string" && discordUserIdRaw.trim()
          ? discordUserIdRaw.trim()
          : "discord:subagent";
      const replyToMessageId =
        typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
          ? pl.reply_to_message_id.trim()
          : undefined;
      const expiresAt = now + lifetimeMs;
      sessions.update(childId, {
        parentSessionId,
        subagentMode: "bound",
        subagentDiscordThreadId: discordThreadId,
        subagentExpiresAtMs: expiresAt,
      });
      const unregisterThread = ext.registerDiscordThreadBinding(discordThreadId, childId);
      const unsubscribeBus = ext.subscribeSubagentSession(childId);
      let ttlTimer: ReturnType<typeof setTimeout> | undefined;
      const clearTtl = () => {
        if (ttlTimer !== undefined) {
          clearTimeout(ttlTimer);
          ttlTimer = undefined;
        }
      };
      ttlTimer = setTimeout(() => {
        ttlTimer = undefined;
        terminateBoundSubagentSession(sessionManager, childId);
      }, lifetimeMs);
      rememberSubagentHandles(childId, {
        unregisterThread,
        unsubscribeBus,
        clearTtl,
      });
      const turn = await ext.runSessionModelTurn({
        sessionId: childId,
        userContent: prompt,
        userMetadata: {
          subagent_bound: true,
          parent_session_id: parentSessionId,
          discord_thread_id: discordThreadId,
        },
        delivery: {
          kind: "messaging_surface",
          userId: discordUserId,
          replyToMessageId,
        },
      });
      ctx.recordIntegrationAudit({
        action: "subagent.spawn_bound",
        resource: childId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify({
          parent_session_id: parentSessionId,
          discord_thread_id: discordThreadId,
          expires_at_ms: expiresAt,
        }),
      });
      return {
        session_id: childId,
        mode: "bound_discord_thread",
        discord_thread_id: discordThreadId,
        expires_at_ms: expiresAt,
        first_reply: turn.latestAssistantText,
        failover: turn.failoverMeta ?? null,
      };
    }

    case "session_list": {
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
      const status =
        typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : undefined;
      const agentFilterRaw = pl.agent;
      const agentFilter =
        typeof agentFilterRaw === "string" && agentFilterRaw.trim()
          ? agentFilterRaw.trim()
          : undefined;

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
        const rows = ctx.sessions.list({ status, agentId: callerAgentId });
        return { sessions: rows.map(mapSessionListRow) };
      }

      if (agentFilter) {
        try {
          assertValidAgentId(agentFilter);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.agent: ${msg}`);
        }
      }
      const rows = ctx.sessions.list({ status, agentId: agentFilter });
      return { sessions: rows.map(mapSessionListRow) };
    }

    case "session_inspect": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_inspect requires operator or agent principal",
        );
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      if (principal.kind === "agent" && sessionId !== principal.sessionId) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "agent may only session_inspect own session",
        );
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
          subagent_discord_thread_id: row.subagentDiscordThreadId ?? null,
          subagent_expires_at_ms: row.subagentExpiresAtMs ?? null,
          workspace_path: row.workspacePath,
          context_segment_id: row.contextSegmentId,
        },
        child_subagents: children,
      };
    }

    case "session_send": {
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
          "session_send requires messaging runtime (e.g. Discord platform started)",
        );
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = resolveSessionSendTargetSessionId(pl, ctx.config);
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
      const discordUserIdRaw = pl.discord_user_id;
      const discordUserId =
        typeof discordUserIdRaw === "string" && discordUserIdRaw.trim()
          ? discordUserIdRaw.trim()
          : "discord:subagent";
      const replyToMessageId =
        typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
          ? pl.reply_to_message_id.trim()
          : undefined;
      const delivery = silent
        ? ({ kind: "internal" } as const)
        : ({
            kind: "messaging_surface",
            userId: discordUserId,
            replyToMessageId,
          } as const);
      const turn = await ext.runSessionModelTurn({
        sessionId,
        userContent: message,
        userMetadata: { session_send: true },
        delivery,
      });
      ctx.recordIntegrationAudit({
        action: "session.send",
        resource: sessionId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify({ silent }),
      });
      return { reply: turn.latestAssistantText, failover: turn.failoverMeta ?? null };
    }

    case "session_steer": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_steer requires operator principal");
      }
      const ext = subagentRuntimeExtensionRef.current;
      if (!ext) {
        throw new IntegrationOpError(
          "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
          "subagent runtime not configured (start messaging platform; Discord when enabled)",
        );
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const prompt = requireString(pl, "prompt");
      const row = sessions.getById(sessionId);
      if (!row || row.status === "terminated") {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
      }
      if (row.subagentMode === "one_shot") {
        throw new IntegrationOpError("ERR_SUBAGENT_ONE_SHOT", "one_shot subagents cannot be steered");
      }
      const discordUserIdRaw = pl.discord_user_id;
      const discordUserId =
        typeof discordUserIdRaw === "string" && discordUserIdRaw.trim()
          ? discordUserIdRaw.trim()
          : "discord:subagent";
      const replyToMessageId =
        typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
          ? pl.reply_to_message_id.trim()
          : undefined;
      const delivery =
        pl.delivery === "internal"
          ? ({ kind: "internal" } as const)
          : ({
              kind: "messaging_surface",
              userId: discordUserId,
              replyToMessageId,
            } as const);
      const turn = await ext.runSessionModelTurn({
        sessionId,
        userContent: prompt,
        userMetadata: { session_steer: true },
        delivery,
      });
      ctx.recordIntegrationAudit({
        action: "session.steer",
        resource: sessionId,
        outcome: "ok",
      });
      return { reply: turn.latestAssistantText, failover: turn.failoverMeta ?? null };
    }

    case "session_abort": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_abort requires operator principal");
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const row = sessions.getById(sessionId);
      if (!row || row.status === "terminated") {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
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

    case "session_kill": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_kill requires operator principal");
      }
      const { sessionManager } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      terminateBoundSubagentSession(sessionManager, sessionId);
      ctx.recordIntegrationAudit({
        action: "session.kill",
        resource: sessionId,
        outcome: "ok",
      });
      return { ok: true };
    }

    default:
      return undefined;
  }
}
