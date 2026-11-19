/**
 * Control plane elevation operations (grant, revoke, list).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
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

function resolveTargetSessionIdOrThrow(
  raw: string,
  cfg: import("@shoggoth/shared").ShoggothConfig,
  sessions: import("../sessions/session-store").SessionStore | undefined,
): string {
  try {
    return resolveSessionTargetFromCliArg(raw, cfg, sessions);
  } catch (e) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Handle elevation_grant control operation.
 */
export async function handleElevationGrant(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "elevation_grant is operator-only");
  }
  const elevGrantPl = payloadObject(req);
  const elevGrantSessionIdRaw =
    typeof elevGrantPl.session_id === "string" ? elevGrantPl.session_id : undefined;
  if (!elevGrantSessionIdRaw) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.session_id is required");
  }
  const elevGrantSessionId = resolveTargetSessionIdOrThrow(
    elevGrantSessionIdRaw,
    ctx.config,
    ctx.sessions,
  );
  if (!ctx.stateDb) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "elevation requires state DB");
  }
  const elevDurationMs =
    typeof elevGrantPl.duration_ms === "number" ? elevGrantPl.duration_ms : undefined;
  const { createElevationStore: createElevStoreGrant } =
    await import("../elevation/elevation-store");
  const elevStoreGrant = createElevStoreGrant(ctx.stateDb);
  const elevGrant = elevStoreGrant.grant(elevGrantSessionId, elevDurationMs);
  return { ok: true, ...elevGrant };
}

/**
 * Handle elevation_revoke control operation.
 */
export async function handleElevationRevoke(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "elevation_revoke is operator-only");
  }
  const elevRevokePl = payloadObject(req);
  if (!ctx.stateDb) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "elevation requires state DB");
  }
  const { createElevationStore: createElevStoreRevoke } =
    await import("../elevation/elevation-store");
  const elevStoreRevoke = createElevStoreRevoke(ctx.stateDb);
  if (typeof elevRevokePl.grant_id === "string") {
    const revokeOk = elevStoreRevoke.revoke(elevRevokePl.grant_id);
    return { ok: revokeOk, revoked: revokeOk };
  }
  const elevRevokeSessionIdRaw =
    typeof elevRevokePl.session_id === "string" ? elevRevokePl.session_id : undefined;
  if (!elevRevokeSessionIdRaw) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.grant_id or payload.session_id is required",
    );
  }
  const elevRevokeSessionId = resolveTargetSessionIdOrThrow(
    elevRevokeSessionIdRaw,
    ctx.config,
    ctx.sessions,
  );
  const revokeCount = elevStoreRevoke.revokeAllForSession(elevRevokeSessionId);
  return { ok: true, revokedCount: revokeCount };
}

/**
 * Handle elevation_list control operation.
 */
export async function handleElevationList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "elevation_list is operator-only");
  }
  const elevListPl = payloadObject(req);
  if (!ctx.stateDb) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "elevation requires state DB");
  }
  const elevListSessionIdRaw =
    typeof elevListPl.session_id === "string" ? elevListPl.session_id : undefined;
  const { createElevationStore: createElevStoreList } =
    await import("../elevation/elevation-store");
  const elevStoreList = createElevStoreList(ctx.stateDb);
  if (elevListSessionIdRaw) {
    const elevListSessionId = resolveTargetSessionIdOrThrow(
      elevListSessionIdRaw,
      ctx.config,
      ctx.sessions,
    );
    const grants = elevStoreList.list(elevListSessionId);
    return { ok: true, grants, count: grants.length };
  }
  const grants = elevStoreList.list();
  return { ok: true, grants, count: grants.length };
}
