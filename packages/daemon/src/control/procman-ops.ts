/**
 * Control plane process manager operations (list, restart, stop).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { getProcessManager } from "../process-manager-singleton";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

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

/**
 * Handle procman_list control operation.
 */
export async function handleProcmanList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  _ctx: IntegrationOpsContext,
): Promise<unknown> {
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

/**
 * Handle procman_restart control operation.
 */
export async function handleProcmanRestart(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  _ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "procman_restart requires operator principal");
  }
  const pl = payloadObject(req);
  const id = requireString(pl, "id");
  const pm = getProcessManager();
  if (!pm)
    throw new IntegrationOpError("ERR_PROCMAN_UNAVAILABLE", "process manager not initialized");
  const mp = pm.get(id);
  if (!mp) {
    throw new IntegrationOpError("ERR_PROCESS_NOT_FOUND", `no managed process with id "${id}"`);
  }
  await mp.restart();
  return { ok: true, id, state: mp.state };
}

/**
 * Handle procman_stop control operation.
 */
export async function handleProcmanStop(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  _ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "procman_stop requires operator principal");
  }
  const pl = payloadObject(req);
  const id = requireString(pl, "id");
  const pm = getProcessManager();
  if (!pm)
    throw new IntegrationOpError("ERR_PROCMAN_UNAVAILABLE", "process manager not initialized");
  const mp = pm.get(id);
  if (!mp) {
    throw new IntegrationOpError("ERR_PROCESS_NOT_FOUND", `no managed process with id "${id}"`);
  }
  await pm.stop(id);
  return { ok: true, id };
}
