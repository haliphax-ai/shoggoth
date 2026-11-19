/**
 * Control plane MCP HTTP request-cancellation operation.
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { dispatchMcpHttpCancelRequest } from "../mcp/mcp-http-cancel-registry";
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
 * Handle mcp.http_cancel_request control operation.
 * Cancels an in-flight MCP streamable HTTP request for a session.
 */
export async function handleMcpHttpCancelRequest(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "mcp_http_cancel_request requires operator principal",
    );
  }
  const pl = payloadObject(req);
  const sessionId = requireString(pl, "session_id");
  const sourceId = requireString(pl, "source_id");
  const requestIdRaw = pl.request_id;
  if (typeof requestIdRaw !== "number" || !Number.isFinite(requestIdRaw)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "payload.request_id must be a finite number",
    );
  }
  const requestId = Math.trunc(requestIdRaw);
  const cancel = ctx.cancelMcpHttpRequest ?? dispatchMcpHttpCancelRequest;
  const cancelled = cancel({ sessionId, sourceId, requestId });
  return { cancelled };
}
