import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { getLogger } from "../logging";
const ioLog = getLogger("integration-ops");
import { getProcessManager } from "../process-manager-singleton";
import {
  agentMayInvokeSubagentSpawnByAllowlist,
  assertValidAgentId,
  crossAgentSessionSendAllowed,
  deepMerge,
  effectiveSpawnSubagentsEnabled,
  loadLayeredConfig,
  parseAgentSessionUrn,
  redactDeep,
  resolveEffectiveModelsConfig,
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
} from "@shoggoth/shared";
import {
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
import type { SessionRow, SessionStore, SessionSortBy } from "../sessions/session-store";
import { resolveSessionTargetFromCliArg } from "./resolve-session-cli-target";
import {
  applySessionContextSegmentNew,
  applySessionContextSegmentReset,
} from "../sessions/session-context-segment";
import type { HitlConfigRef } from "../config-hot-reload";
import { rewriteAgentToolAutoApproveMapAndReload, readAgentToolAutoApproveMap } from "../hitl/hitl-agent-tool-auto-persist";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import {
  clearAllSessionToolAutoApprove,
  clearSessionToolAutoApproveForSessionIds,
} from "../hitl/hitl-session-tool-auto-store";
import { mergeSubagentSpawnModelSelection } from "@shoggoth/models";
import {
  createFailoverClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
} from "@shoggoth/models";
import { compactSessionTranscript } from "../transcript-compact";
import { getSessionStats, estimateCurrentContextFill, buildFormattedStats } from "../sessions/session-stats-store";
import { dispatchMcpHttpCancelRequest } from "../mcp/mcp-http-cancel-registry";
import { SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS } from "../subagent/subagent-constants";
import { requestSessionTurnAbort } from "../sessions/session-turn-abort";
import { disposeSubagentRuntime, rememberSubagentHandles } from "../subagent/subagent-disposables";
import { subagentRuntimeExtensionRef } from "../subagent/subagent-extension-ref";
import { terminatePersistentSubagentSession } from "../subagent/subagent-kill";
import { extractLatestTranscriptAssistantText } from "../sessions/transcript-to-chat";
import { pushSystemContext } from "../sessions/system-context-buffer";
import { getTurnQueue } from "../sessions/session-turn-queue-singleton";

export class IntegrationOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationOpError";
  }
}

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
   * When set with {@link hitlPending}, `hitl_clear` can wipe agent/session auto-approve (disk + memory).
   * Omitted in minimal setups (e.g. tests with only the pending store).
   */
  readonly hitlClear?: {
    readonly configDirectory: string;
    readonly dynamicConfigDirectory?: string;
    readonly configRef: { current: ShoggothConfig };
    readonly hitlRef: HitlConfigRef;
    readonly autoApproveGate: HitlAutoApproveGate;
  };
  /**
   * MCP streamable HTTP cancel routing (default: process registry filled by the active platform).
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

function mapSessionListRow(row: SessionRow) {
  return {
    id: row.id,
    status: row.status,
    workspace_path: row.workspacePath,
    context_segment_id: row.contextSegmentId,
    parent_session_id: row.parentSessionId ?? null,
    subagent_mode: row.subagentMode ?? null,
    subagent_platform_thread_id: row.subagentPlatformThreadId ?? null,
    subagent_expires_at_ms: row.subagentExpiresAtMs ?? null,
    light_context: row.lightContext,
    created_at: row.createdAt || null,
    updated_at: row.updatedAt || null,
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

/** When false in config, agent principals cannot use subagent spawn, inspect, steer, abort, or kill. */
function assertAgentSpawnSubagentsAllowed(
  principal: AuthenticatedPrincipal,
  config: ShoggothConfig,
): void {
  if (principal.kind !== "agent") return;
  const agentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
  if (!effectiveSpawnSubagentsEnabled(config, agentId)) {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "subagent operations disabled for this agent (spawnSubagents is false)",
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
 * Control-plane handlers for ACPX workspace bindings and managed acpx processes.
 */
export async function handleIntegrationControlOp(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind === "operator") {
    ioLog.info("operator action", { op: req.op, operatorId: principal.operatorId });
  }
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
        killSubagents: ctx.sessionManager
          ? (childIds) => {
              for (const cid of childIds) {
                terminatePersistentSubagentSession(ctx.sessionManager!, cid, "killed");
              }
            }
          : undefined,
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

    case "session_compact": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_compact requires operator principal");
      }
      if (!ctx.stateDb) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session_compact requires state database");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const force = pl.force === true;
      const modelsConfig = resolveEffectiveModelsConfig(ctx.config, sessionId) ?? ctx.config.models;
      const policy = resolveCompactionPolicyFromModelsConfig(modelsConfig);
      const client = createFailoverClientFromModelsConfig(modelsConfig, { env: process.env });
      const result = await compactSessionTranscript(ctx.stateDb, sessionId, policy, client, {
        force,
        modelsConfig,
      });
      ctx.recordIntegrationAudit({
        action: "session.compact",
        resource: sessionId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify(result),
      });
      return result;
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

    case "hitl_clear": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "hitl_clear requires operator principal");
      }
      if (!ctx.hitlPending) {
        throw new IntegrationOpError("ERR_HITL_UNAVAILABLE", "HITL pending store not configured");
      }
      if (!ctx.stateDb || !ctx.sessions) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "hitl_clear requires SQLite session store");
      }
      const pl = payloadObject(req);
      const agentIdRaw = requireString(pl, "agent_id").trim();
      if (agentIdRaw !== "all") {
        assertValidAgentId(agentIdRaw);
      }
      const sessionIdOpt = optionalNonEmptySessionId(pl);
      const noAuto = pl.no_auto === true;
      /** Session-scoped clear never touches auto-approve (SQLite / z-JSON / memory). */
      const skipAutoClear = Boolean(sessionIdOpt) || noAuto;

      let sessionIds: string[];
      if (sessionIdOpt) {
        const parsed = parseAgentSessionUrn(sessionIdOpt);
        if (!parsed) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "payload.session_id must be a valid agent session URN",
          );
        }
        if (agentIdRaw !== "all" && parsed.agentId !== agentIdRaw) {
          throw new IntegrationOpError(
            "ERR_INVALID_PAYLOAD",
            "payload.session_id agent does not match payload.agent_id",
          );
        }
        const row = ctx.sessions.getById(sessionIdOpt);
        if (!row) {
          throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
        }
        sessionIds = [sessionIdOpt];
      } else if (agentIdRaw === "all") {
        sessionIds = ctx.sessions.list().map((r) => r.id);
      } else {
        sessionIds = ctx.sessions.list({ agentId: agentIdRaw }).map((r) => r.id);
      }

      const deletedPending = ctx.hitlPending.deletePendingForSessionIds(sessionIds);

      let clearedSessionAutoApprove = 0;
      let clearedAgentAutoApproveAgents = 0;
      if (!skipAutoClear) {
        const hc = ctx.hitlClear;
        if (!hc) {
          throw new IntegrationOpError(
            "ERR_HITL_UNAVAILABLE",
            "HITL auto-approve clear not configured (requires persisting HITL gate)",
          );
        }
        if (agentIdRaw === "all") {
          clearedSessionAutoApprove = clearAllSessionToolAutoApprove(ctx.stateDb);
        } else {
          clearedSessionAutoApprove = clearSessionToolAutoApproveForSessionIds(ctx.stateDb, sessionIds);
        }
        const merged = readAgentToolAutoApproveMap(loadLayeredConfig(hc.configDirectory));
        const nextMap: Record<string, string[]> =
          agentIdRaw === "all"
            ? Object.fromEntries(Object.keys(merged).map((k) => [k, [] as string[]]))
            : { ...merged, [agentIdRaw]: [] };
        if (hc.dynamicConfigDirectory) {
          rewriteAgentToolAutoApproveMapAndReload({
            configDirectory: hc.configDirectory,
            dynamicConfigDirectory: hc.dynamicConfigDirectory,
            configRef: hc.configRef,
            hitlRef: hc.hitlRef,
            nextAgentToolAutoApprove: nextMap,
          });
        }
        clearedAgentAutoApproveAgents = agentIdRaw === "all" ? Object.keys(merged).length : 1;
        if (agentIdRaw === "all") {
          hc.autoApproveGate.clearAutoApproveMemory?.({ agents: "all" });
        } else {
          hc.autoApproveGate.clearAutoApproveMemory?.({ agents: [agentIdRaw] });
        }
      }

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
        cleared_session_auto_approve: clearedSessionAutoApprove,
        cleared_agent_auto_approve_agents: clearedAgentAutoApproveAgents,
      };
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
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
        const callerAgentId = parseAgentSessionUrn(principal.sessionId)?.agentId;
        if (
          callerAgentId &&
          !agentMayInvokeSubagentSpawnByAllowlist(ctx.config, callerAgentId)
        ) {
          throw new IntegrationOpError(
            "ERR_FORBIDDEN",
            "subagent_spawn denied for this agent id (subagentSpawnAllow)",
          );
        }
      }
      const ext = subagentRuntimeExtensionRef.current;
      if (!ext) {
        throw new IntegrationOpError(
          "ERR_SUBAGENT_RUNTIME_UNAVAILABLE",
          "subagent runtime not configured (start messaging platform)",
        );
      }
      const { sessions, sessionManager } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const parentSessionId = requireString(pl, "parent_session_id");
      assertAgentMayUseSubagentSpawn(principal, parentSessionId, sessions);
      const prompt = requireString(pl, "prompt");
      const modeRaw = requireString(pl, "mode");
      if (modeRaw !== "one_shot" && modeRaw !== "persistent") {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          "payload.mode must be one_shot or persistent",
        );
      }
      const parent = sessions.getById(parentSessionId);
      if (!parent || parent.status === "terminated") {
        throw new IntegrationOpError(
          "ERR_PARENT_SESSION_INVALID",
          "parent session is missing or terminated",
        );
      }      const modelOptions = optionalRecordObject(pl, "model_options");
      const modelSelection = mergeSubagentSpawnModelSelection(parent.modelSelection, modelOptions);

      // Optional response delivery routing (defaults: respondTo = parent, internal = true).
      const respondToRaw = pl.respond_to;
      const respondTo =
        typeof respondToRaw === "string" && respondToRaw.trim()
          ? respondToRaw.trim()
          : parentSessionId;
      const internalDelivery = pl.internal !== false; // default true

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
          subagentPlatformThreadId: null,
          subagentExpiresAtMs: null,
        });
        const subLog = getLogger("subagent");
        subLog.info("subagent one_shot model turn starting", { childId, parentSessionId, promptLen: prompt.length });
        pushSystemContext(childId, "One-shot subagent task spawned by parent session.");
        const turn = await ext.runSessionModelTurn({
          sessionId: childId,
          userContent: prompt,
          userMetadata: {
            subagent_one_shot: true,
            parent_session_id: parentSessionId,
            respond_to: respondTo,
            internal: internalDelivery,
          },
          systemContext: {
            kind: "subagent.task",
            summary: "You are a one-shot subagent. Complete the following task and return the result.",
            data: { parent_session_id: parentSessionId, respond_to: respondTo, internal: internalDelivery },
          },
          delivery: { kind: "internal" },
        });
        subLog.info("subagent one_shot model turn completed", { childId, replyLen: turn.latestAssistantText?.length ?? 0 });
        terminatePersistentSubagentSession(sessionManager, childId);
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
          respond_to: respondTo,
          internal: internalDelivery,
          failover: turn.failoverMeta ?? null,
        };
      }
      const platformThreadIdRaw = pl.platform_thread_id;
      const platformThreadId =
        typeof platformThreadIdRaw === "string" && platformThreadIdRaw.trim()
          ? platformThreadIdRaw.trim()
          : undefined;
      const lifetimeMs = optionalFinitePositiveInt(pl, "lifetime_ms") ?? SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS;
      const platformUserIdRaw = pl.platform_user_id;
      const platformUserId =
        typeof platformUserIdRaw === "string" && platformUserIdRaw.trim()
          ? platformUserIdRaw.trim()
          : undefined;
      const replyToMessageId =
        typeof pl.reply_to_message_id === "string" && pl.reply_to_message_id.trim()
          ? pl.reply_to_message_id.trim()
          : undefined;
      const expiresAt = now + lifetimeMs;
      sessions.update(childId, {
        parentSessionId,
        subagentMode: "persistent",
        subagentPlatformThreadId: platformThreadId ?? null,
        subagentExpiresAtMs: expiresAt,
      });
      const unregisterThread = platformThreadId
        ? ext.registerPlatformThreadBinding(platformThreadId, childId)
        : () => {};
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
        terminatePersistentSubagentSession(sessionManager, childId, "ttl_expired");
      }, lifetimeMs);
      rememberSubagentHandles(childId, {
        unregisterThread,
        unsubscribeBus,
        clearTtl,
      });
      const delivery = platformThreadId
        ? (() => {
            if (!platformUserId) {
              throw new IntegrationOpError(
                "ERR_MISSING_PLATFORM_USER_ID",
                "platform_user_id is required for messaging_surface delivery",
              );
            }
            return {
              kind: "messaging_surface",
              userId: platformUserId,
              replyToMessageId,
            } as const;
          })()
        : ({ kind: "internal" } as const);
      const turn = await ext.runSessionModelTurn({
        sessionId: childId,
        userContent: prompt,
        userMetadata: {
          subagent_persistent: true,
          parent_session_id: parentSessionId,
          platform_thread_id: platformThreadId ?? null,
          respond_to: respondTo,
          internal: internalDelivery,
        },
        systemContext: {
          kind: "subagent.task",
          summary: "You are a persistent subagent session. Complete the following task.",
          data: {
            parent_session_id: parentSessionId,
            respond_to: respondTo,
            platform_thread_id: platformThreadId ?? null,
            internal: internalDelivery,
          },
        },
        delivery,
      });
      ctx.recordIntegrationAudit({
        action: "subagent.spawn_persistent",
        resource: childId,
        outcome: "ok",
        argsRedactedJson: JSON.stringify({
          parent_session_id: parentSessionId,
          platform_thread_id: platformThreadId ?? null,
          expires_at_ms: expiresAt,
        }),
      });
      return {
        session_id: childId,
        mode: "persistent",
        platform_thread_id: platformThreadId ?? null,
        expires_at_ms: expiresAt,
        respond_to: respondTo,
        internal: internalDelivery,
        first_reply: turn.latestAssistantText,
        failover: turn.failoverMeta ?? null,
      };
    }

    case "subagent_wait": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "subagent_wait requires operator or agent principal",
        );
      }
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionIds = optionalStringArray(pl, "session_ids");
      if (!sessionIds || sessionIds.length === 0) {
        throw new IntegrationOpError(
          "ERR_INVALID_PAYLOAD",
          "payload.session_ids must be a non-empty array of strings",
        );
      }
      const timeoutMs = optionalFinitePositiveInt(pl, "timeout_ms") ?? 300_000;
      const modeRaw = pl.mode;
      const mode =
        modeRaw === "any" ? "any" : "all"; // default "all"
      const includeResults = pl.include_results === true;
      const maxCharsEach = optionalFinitePositiveInt(pl, "max_chars") ?? 4000;

      // Validate that agent can only wait on its own direct children.
      if (principal.kind === "agent") {
        for (const sid of sessionIds) {
          const row = sessions.getById(sid);
          if (row && row.parentSessionId !== principal.sessionId) {
            throw new IntegrationOpError(
              "ERR_FORBIDDEN",
              `agent may only wait on direct child subagents (${sid})`,
            );
          }
        }
      }

      const POLL_INTERVAL_MS = optionalFinitePositiveInt(pl, "_poll_interval_ms") ?? 500;
      const deadline = Date.now() + timeoutMs;

      /** Check whether a session counts as "completed" (terminated, or not found). */
      const resolveSessionStatus = (
        sid: string,
      ): { sessionId: string; status: string; exitReason: string } | null => {
        const row = sessions.getById(sid);
        if (!row) {
          return { sessionId: sid, status: "done", exitReason: "not_found" };
        }
        if (row.status === "terminated") {
          return { sessionId: sid, status: "done", exitReason: "natural" };
        }
        return null; // still running
      };

      const completed: { sessionId: string; status: string; exitReason: string; result?: string; truncated?: boolean }[] = [];
      const remaining = new Set(sessionIds);

      // Check for already-completed sessions first.
      for (const sid of sessionIds) {
        const resolved = resolveSessionStatus(sid);
        if (resolved) {
          if (includeResults) {
            const row = sessions.getById(sid);
            if (row && ctx.stateDb) {
              const text = extractLatestTranscriptAssistantText(ctx.stateDb, sid, row.contextSegmentId) ?? "";
              const truncated = text.length > maxCharsEach;
              Object.assign(resolved, {
                result: truncated ? text.slice(0, maxCharsEach) : text,
                truncated,
              });
            } else {
              Object.assign(resolved, { result: "", truncated: false });
            }
          }
          completed.push(resolved);
          remaining.delete(sid);
        }
      }

      // If mode=any and we already have one, or mode=all and all done, return immediately.
      if (
        remaining.size === 0 ||
        (mode === "any" && completed.length > 0)
      ) {
        return {
          completed,
          pending: [...remaining].map((sid) => ({ sessionId: sid, status: "running" })),
          timedOut: false,
        };
      }

      // Poll loop — yield execution between checks.
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        for (const sid of [...remaining]) {
          const resolved = resolveSessionStatus(sid);
          if (resolved) {
            if (includeResults) {
              const row = sessions.getById(sid);
              if (row && ctx.stateDb) {
                const text = extractLatestTranscriptAssistantText(ctx.stateDb, sid, row.contextSegmentId) ?? "";
                const truncated = text.length > maxCharsEach;
                Object.assign(resolved, {
                  result: truncated ? text.slice(0, maxCharsEach) : text,
                  truncated,
                });
              } else {
                Object.assign(resolved, { result: "", truncated: false });
              }
            }
            completed.push(resolved);
            remaining.delete(sid);
          }
        }
        if (remaining.size === 0 || (mode === "any" && completed.length > 0)) {
          break;
        }
      }

      return {
        completed,
        pending: [...remaining].map((sid) => ({ sessionId: sid, status: "running" })),
        timedOut: remaining.size > 0,
      };
    }

    case "subagent_result": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "subagent_result requires operator or agent principal",
        );
      }
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const maxChars = optionalFinitePositiveInt(pl, "max_chars") ?? 8000;

      // Agent can only read results from direct children.
      if (principal.kind === "agent") {
        const row = sessions.getById(sessionId);
        if (row && row.parentSessionId !== principal.sessionId) {
          throw new IntegrationOpError(
            "ERR_FORBIDDEN",
            "agent may only read results from direct child subagents",
          );
        }
      }

      const row = sessions.getById(sessionId);
      if (!row) {
        return { sessionId, status: "not_found", result: null, truncated: false };
      }
      if (row.status !== "terminated") {
        return { sessionId, status: "running", result: null, truncated: false };
      }
      if (!ctx.stateDb) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "subagent_result requires state database");
      }
      const text = extractLatestTranscriptAssistantText(ctx.stateDb, sessionId, row.contextSegmentId) ?? "";
      const truncated = text.length > maxChars;
      return {
        sessionId,
        status: "done",
        result: truncated ? text.slice(0, maxChars) : text,
        truncated,
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
        const rows = ctx.sessions.list({
          status,
          agentId: callerAgentId,
          sortBy,
          sortOrder,
          activeSince,
          limit,
        });
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
      const rows = ctx.sessions.list({
        status,
        agentId: agentFilter,
        sortBy,
        sortOrder,
        activeSince,
        limit,
      });
      return { sessions: rows.map(mapSessionListRow) };
    }

    case "session_context_status": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_context_status requires operator or agent principal",
        );
      }
      if (!ctx.stateDb) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session_context_status requires state database");
      }
      if (!ctx.sessions) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session_context_status requires session store");
      }
      const sessionsStore = ctx.sessions;
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
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
      // Calculate current context fill from transcript
      let contextFillTokens = 0;
      let formattedStats: ReturnType<typeof buildFormattedStats> | null = null;
      if (statsData && row) {
        contextFillTokens = estimateCurrentContextFill(ctx.stateDb, sessionId, row.contextSegmentId.trim());
        formattedStats = buildFormattedStats(statsData, contextFillTokens);
      }
      let modelData: { providerId: string | null; model: string | null } | null = null;
      if (row) {
        try {
          const modelSel = row.modelSelection as Record<string, unknown> | undefined;
          let providerId: string | null = null;
          let modelName: string | null = null;
          if (modelSel && typeof modelSel === "object") {
            providerId = (modelSel.providerId as string) ?? null;
            modelName = (modelSel.model as string) ?? null;
          }
          if (!providerId || !modelName) {
            const modelsConfig = resolveEffectiveModelsConfig(ctx.config, sessionId);
            const chain = modelsConfig?.failoverChain;
            if (chain && chain.length > 0) {
              const first = chain[0];
              if (!providerId) providerId = first.providerId ?? null;
              if (!modelName) modelName = first.model ?? null;
            }
          }
          modelData = { providerId, model: modelName };
        } catch {
          modelData = null;
        }
      }
      let queueDepth: { system: number; user: number } | null = null;
      try {
        queueDepth = getTurnQueue().getDepth(sessionId);
      } catch { /* queue not initialized */ }
      return {
        session: sessionData,
        stats: statsData ?? null,
        formattedStats: formattedStats ?? null,
        model: modelData,
        queueDepth,
      };
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
      if (principal.kind === "agent") {
        if (sessionId !== principal.sessionId) {
          throw new IntegrationOpError(
            "ERR_FORBIDDEN",
            "agent may only session_inspect own session",
          );
        }
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
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

    case "session_send": {
      ioLog.debug("subagent conversation: send", { op: req.op, principalKind: principal.kind });
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
            if (!platformUserId) {
              throw new IntegrationOpError(
                "ERR_MISSING_PLATFORM_USER_ID",
                "platform_user_id is required for messaging_surface delivery",
              );
            }
            return {
              kind: "messaging_surface",
              userId: platformUserId,
              replyToMessageId,
            } as const;
          })();
      const senderSessionId = principal.kind === "agent" ? principal.sessionId : `operator:${principal.operatorId}`;
      const turn = await ext.runSessionModelTurn({
        sessionId,
        userContent: message,
        userMetadata: { session_send: true },
        systemContext: {
          kind: "session.message",
          summary: `Message from session ${senderSessionId}.`,
          data: { sender_session_id: senderSessionId },
        },
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
      ioLog.debug("subagent conversation: steer", { op: req.op, principalKind: principal.kind });
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_steer requires operator or agent principal",
        );
      }
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
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
      const sessionId = requireString(pl, "session_id");
      const prompt = requireString(pl, "prompt");
      const row = sessions.getById(sessionId);
      if (!row || row.status === "terminated") {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
      }
      if (principal.kind === "agent" && row.parentSessionId !== principal.sessionId) {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "agent may only steer direct child subagents",
        );
      }
      if (row.subagentMode === "one_shot") {
        throw new IntegrationOpError("ERR_SUBAGENT_ONE_SHOT", "one_shot subagents cannot be steered");
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
              if (!platformUserId) {
                throw new IntegrationOpError(
                  "ERR_MISSING_PLATFORM_USER_ID",
                  "platform_user_id is required for messaging_surface delivery",
                );
              }
              return {
                kind: "messaging_surface",
                userId: platformUserId,
                replyToMessageId,
              } as const;
            })();
      const senderInfo = principal.kind === "agent" ? principal.sessionId : `operator:${principal.operatorId}`;
      const turn = await ext.runSessionModelTurn({
        sessionId,
        userContent: prompt,
        userMetadata: { session_steer: true },
        systemContext: {
          kind: "session.steer",
          summary: "Operator steering directive. Adjust your behavior accordingly.",
          data: { steered_by: senderInfo },
        },
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
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_abort requires operator or agent principal",
        );
      }
      const { sessions } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const row = sessions.getById(sessionId);
      if (!row || row.status === "terminated") {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
      }
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
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

    case "session_kill": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError(
          "ERR_FORBIDDEN",
          "session_kill requires operator or agent principal",
        );
      }
      const { sessions, sessionManager } = requireSubagentRuntime(ctx);
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const targetRow = sessions.getById(sessionId);
      if (principal.kind === "agent") {
        assertAgentSpawnSubagentsAllowed(principal, ctx.config);
        if (!targetRow || targetRow.status === "terminated") {
          throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated");
        }
        if (targetRow.parentSessionId !== principal.sessionId) {
          throw new IntegrationOpError(
            "ERR_FORBIDDEN",
            "agent may only kill direct child subagents",
          );
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
      );
      ctx.recordIntegrationAudit({
        action: "session.kill",
        resource: sessionId,
        outcome: "ok",
      });
      return { ok: true };
    }

    case "session_model": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_model requires operator principal");
      }
      if (!ctx.stateDb || !ctx.sessions) {
        throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "session_model requires state database");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const row = ctx.sessions.getById(sessionId);
      if (!row) {
        throw new IntegrationOpError("ERR_SESSION_INACTIVE", "session not found");
      }
      const hasSelection = "model_selection" in pl;
      if (hasSelection) {
        const val = pl.model_selection;
        const modelSelection = val === null ? undefined : val;
        ctx.sessions.update(sessionId, { modelSelection: modelSelection ?? null });
        const updated = ctx.sessions.getById(sessionId);
        const effective = resolveEffectiveModelsConfig(ctx.config, sessionId) ?? null;
        return {
          ok: true,
          session_id: sessionId,
          model_selection: updated?.modelSelection ?? null,
          effective_models: effective,
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

    case "config_show": {
      if (principal.kind !== "operator" && principal.kind !== "agent") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "config_show requires operator or agent principal");
      }
      const csPayload = payloadObject(req);
      const dynamicOnly = csPayload.dynamic === true;
      if (dynamicOnly) {
        const dynDir = ctx.config.dynamicConfigDirectory;
        if (!dynDir || !existsSync(dynDir)) {
          return { ok: true, fragments: {} };
        }
        const fragments: Record<string, unknown> = {};
        for (const name of readdirSync(dynDir).sort()) {
          if (!name.endsWith(".json")) continue;
          try {
            fragments[name.slice(0, -5)] = JSON.parse(readFileSync(join(dynDir, name), "utf8"));
          } catch { continue; }
        }
        const jsonPaths = ctx.config.policy.auditRedaction.jsonPaths;
        return { ok: true, fragments: redactDeep(fragments, jsonPaths) };
      }
      const jsonPaths = ctx.config.policy.auditRedaction.jsonPaths;
      return { ok: true, config: redactDeep(ctx.config, jsonPaths) };
    }

    case "procman_list": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "procman_list requires operator principal");
      }
      const pm = getProcessManager();
      if (!pm) return { processes: [] };
      const processes = pm.list().map((mp) => ({
        id: mp.spec.id,
        label: mp.spec.label ?? null,
        state: mp.state,
        pid: mp.pid ?? null,
        uptimeMs: mp.uptimeMs,
        restartCount: mp.restartCount,
        lastExitCode: mp.lastExitCode,
        owner: mp.spec.owner,
      }));
      return { processes };
    }

    case "procman_restart": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "procman_restart requires operator principal");
      }
      const pl = payloadObject(req);
      const id = requireString(pl, "id");
      const pm = getProcessManager();
      if (!pm) throw new IntegrationOpError("ERR_PROCMAN_UNAVAILABLE", "process manager not initialized");
      const mp = pm.get(id);
      if (!mp) {
        throw new IntegrationOpError("ERR_PROCESS_NOT_FOUND", `no managed process with id "${id}"`);
      }
      await mp.restart();
      return { ok: true, id, state: mp.state };
    }

    case "procman_stop": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "procman_stop requires operator principal");
      }
      const pl = payloadObject(req);
      const id = requireString(pl, "id");
      const pm = getProcessManager();
      if (!pm) throw new IntegrationOpError("ERR_PROCMAN_UNAVAILABLE", "process manager not initialized");
      const mp = pm.get(id);
      if (!mp) {
        throw new IntegrationOpError("ERR_PROCESS_NOT_FOUND", `no managed process with id "${id}"`);
      }
      await pm.stop(id);
      return { ok: true, id };
    }

    case "config_request": {
      if (principal.kind !== "agent") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "config_request requires agent principal");
      }
      if (!ctx.config.dynamicConfigDirectory) {
        throw new IntegrationOpError(
          "ERR_CONFIG_REQUEST_UNAVAILABLE",
          "dynamicConfigDirectory not configured",
        );
      }
      const pl = payloadObject(req);
      const crKey = typeof pl.key === "string" ? pl.key.trim() : "";
      if (!crKey || !/^[a-zA-Z0-9_-]+$/.test(crKey)) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.key is required and must contain only alphanumeric characters, hyphens, and underscores");
      }
      const crMode = pl.mode === "overwrite" ? "overwrite" : "merge";
      const fragmentRaw = pl.fragment;
      if (fragmentRaw === undefined || fragmentRaw === null) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.fragment is required");
      }
      // Wrap the fragment value under the key for schema validation and storage.
      const wrappedRaw = { [crKey]: fragmentRaw };
      const wrappedParse = shoggothConfigFragmentSchema.safeParse(wrappedRaw);
      if (!wrappedParse.success) {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", wrappedParse.error.message);
      }
      let wrapped = wrappedParse.data;
      const dynDir = ctx.config.dynamicConfigDirectory;
      mkdirSync(dynDir, { recursive: true });
      const filePath = join(dynDir, `${crKey}.json`);
      if (crMode === "merge" && existsSync(filePath)) {
        try {
          const existing = JSON.parse(readFileSync(filePath, "utf8"));
          wrapped = deepMerge(existing, wrapped);
        } catch { /* overwrite if existing file is unreadable */ }
      }
      const currentConfig = loadLayeredConfig(ctx.config.configDirectory);
      const merged = deepMerge(currentConfig, wrapped);
      const fullParse = shoggothConfigSchema.safeParse(merged);
      if (!fullParse.success) {
        return { ok: false, error: "validation_failed", details: fullParse.error };
      }
      writeFileSync(filePath, JSON.stringify(wrapped, null, 2), { encoding: "utf8" });
      return { ok: true, path: filePath, key: crKey, mode: crMode };
    }

    case "session_queue_manage": {
      if (principal.kind !== "operator") {
        throw new IntegrationOpError("ERR_FORBIDDEN", "session_queue_manage requires operator principal");
      }
      const pl = payloadObject(req);
      const sessionId = requireString(pl, "session_id");
      const action = requireString(pl, "action");
      const priorityRaw = pl.priority;
      const priority =
        priorityRaw === "system" || priorityRaw === "user" ? priorityRaw : undefined;
      const priorityOrAll = priority ?? "all";

      let queue: import("../sessions/session-turn-queue").TieredTurnQueue;
      try {
        queue = getTurnQueue();
      } catch {
        throw new IntegrationOpError("ERR_QUEUE_UNAVAILABLE", "turn queue not initialized");
      }

      if (action === "list") {
        const entries = queue.listQueued(sessionId, priority).map((e, i) => ({
          id: e.id,
          priority: e.priority,
          label: e.label,
          enqueuedAt: e.enqueuedAt,
          index: i,
        }));
        return { entries };
      }

      if (action === "clear") {
        const removed = queue.clear(sessionId, priority);
        return { removed };
      }

      if (action === "remove") {
        const by = pl.by;
        if (by === "index") {
          const idx = pl.index;
          if (typeof idx !== "number" || !Number.isFinite(idx)) {
            throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.index must be a finite number");
          }
          const removed = queue.removeByRange(sessionId, priorityOrAll, idx, idx);
          return { removed };
        }
        if (by === "range") {
          const start = pl.start;
          const end = pl.end;
          if (typeof start !== "number" || typeof end !== "number") {
            throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.start and payload.end required");
          }
          const removed = queue.removeByRange(sessionId, priorityOrAll, start, end);
          return { removed };
        }
        if (by === "count") {
          const count = pl.count;
          if (typeof count !== "number" || !Number.isFinite(count) || count < 1) {
            throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.count must be a positive number");
          }
          const removed = queue.removeByCount(sessionId, priorityOrAll, count);
          return { removed };
        }
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.by must be index, range, or count");
      }

      throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.action must be list, remove, or clear");
    }

    default:
      return undefined;
  }
}
