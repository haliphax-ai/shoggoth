/**
 * Control plane yolo mode operation.
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
 * Handle yolo_mode control operation.
 */
export async function handleYoloMode(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError("ERR_FORBIDDEN", "yolo_mode is operator-only");
  }
  const yoloPl = payloadObject(req);
  const yoloSessionIdRaw = typeof yoloPl.session_id === "string" ? yoloPl.session_id : undefined;
  if (!yoloSessionIdRaw) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload.session_id is required");
  }
  const yoloSessionId = resolveTargetSessionIdOrThrow(yoloSessionIdRaw, ctx.config, ctx.sessions);
  if (!ctx.stateDb) {
    throw new IntegrationOpError("ERR_STATE_DB_REQUIRED", "yolo mode requires state DB");
  }
  const yoloAction =
    typeof yoloPl.action === "string" && yoloPl.action.length > 0 ? yoloPl.action : "on";
  if (yoloAction !== "on" && yoloAction !== "off" && yoloAction !== "status") {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.action must be on, off, or status",
    );
  }
  const { createYoloModeStore: createYoloStore } = await import("../hitl/yolo-mode-store");
  const yoloStore = createYoloStore(ctx.stateDb);
  if (yoloAction === "status") {
    return { ok: true, sessionId: yoloSessionId, enabled: yoloStore.isEnabled(yoloSessionId) };
  }
  yoloStore.setEnabled(yoloSessionId, yoloAction === "on");
  return { ok: true, sessionId: yoloSessionId, enabled: yoloAction === "on" };
}
