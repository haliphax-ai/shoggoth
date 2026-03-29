import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import type { ShoggothConfig } from "@shoggoth/shared";
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
import type { SessionStore } from "../sessions/session-store";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import { dispatchMcpHttpCancelRequest } from "../mcp/mcp-http-cancel-registry";

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

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be a non-empty string`);
  }
  return v;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", `payload.${key} must be an array of strings`);
  }
  return v as string[];
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
export function handleIntegrationControlOp(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): unknown {
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

    default:
      return undefined;
  }
}
