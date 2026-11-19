/**
 * Control plane acpx operations (bindings and agent lifecycle).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";
import {
  SHOGGOTH_ACPX_WORKSPACE_ROOT_ENV,
  SHOGGOTH_CONTROL_SOCKET_ENV,
  SHOGGOTH_SESSION_ID_ENV,
} from "@shoggoth/mcp-integration";
import type { AcpxProcessSupervisor } from "../acpx/acpx-process-supervisor";
import { AcpxSupervisorError } from "../acpx/acpx-process-supervisor";
import type { AcpxBindingStore } from "../acpx/sqlite-acpx-bindings";
import { SessionManagerError, type SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

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

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      `payload.${key} must be an array of strings`,
    );
  }
  return v as string[];
}

/**
 * Handle acpx.bind_get control operation.
 * Returns the binding for an ACP workspace root (agents only see their own binding).
 */
export async function handleAcpxBindGet(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
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

/**
 * Handle acpx.bind_set control operation.
 * Creates or updates the binding for an ACP workspace root.
 */
export async function handleAcpxBindSet(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
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
  ctx.acpxStore.upsert({
    acpWorkspaceRoot,
    shoggothSessionId,
    agentPrincipalId,
  });
  return { ok: true };
}

/**
 * Handle acpx.bind_delete control operation.
 * Removes the binding for an ACP workspace root.
 */
export async function handleAcpxBindDelete(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
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

/**
 * Handle acpx.bind_list control operation.
 * Returns all ACP workspace bindings.
 */
export async function handleAcpxBindList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_bind_list requires operator principal");
  }
  if (!ctx.acpxStore) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "acpx bindings require state database");
  }
  return { bindings: ctx.acpxStore.list() };
}

/**
 * Handle acpx.agent_start control operation.
 * Launches the configured acpx binary bound to a Shoggoth session.
 */
export async function handleAcpxAgentStart(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "acpx_agent_start requires operator principal");
  }
  const rt = requireAcpxRuntime(ctx);
  const pl = payloadObject(req);
  const root = requireString(pl, "acp_workspace_root");
  const binding = rt.acpxStore.get(root);
  if (!binding) {
    throw new IntegrationOpError(
      "ERR_ACPX_BINDING_NOT_FOUND",
      `no binding for workspace root ${root}`,
    );
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

/**
 * Handle acpx.agent_stop control operation.
 * Stops a running acpx agent by ACP workspace root.
 */
export async function handleAcpxAgentStop(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
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

/**
 * Handle acpx.agent_list control operation.
 * Lists running acpx agents.
 */
export async function handleAcpxAgentList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
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
