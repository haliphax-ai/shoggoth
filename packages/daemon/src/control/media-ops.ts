/**
 * Control plane media generation operations (generate and poll).
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { MediaGenerationService } from "../media/media-generation-service";
import type { IntegrationOpsContext } from "./integration-ops";
import { IntegrationOpError } from "./integration-ops";

function payloadObject(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

/**
 * Handle media_generate control operation.
 */
export async function handleMediaGenerate(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "agent" && principal.kind !== "operator") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "media_generate requires agent or operator principal",
    );
  }
  const pl = payloadObject(req);
  // model is optional — falls back to the configured media-type default
  const modelRaw = pl.model;
  if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== "string" || !modelRaw)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "media_generate model must be a non-empty string",
    );
  }
  const model = typeof modelRaw === "string" && modelRaw ? modelRaw : undefined;
  if (model && (model.indexOf("/") <= 0 || model.indexOf("/") === model.length - 1)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "media_generate model must be in provider-id/model-id format",
    );
  }
  const prompt = pl.prompt;
  if (typeof prompt !== "string" || prompt === undefined) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "media_generate requires prompt");
  }
  const params = pl.params;
  if (!params || typeof params !== "object") {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "media_generate requires params");
  }
  if (!(params as any).kind) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "media_generate params requires kind");
  }
  const mediaGenConfig = (ctx.config as any).mediaGeneration;
  if (!mediaGenConfig) {
    return { status: "error", error: `No mediaGeneration config found` };
  }
  const svc = (ctx.createMediaGenerationService ?? MediaGenerationService.fromConfig)(
    mediaGenConfig,
  );
  return svc.generate({
    model,
    prompt,
    params: params as any,
    output_path:
      typeof pl.output_path === "string" ? pl.output_path : `/tmp/media/${Date.now()}.bin`,
    timeout_ms: typeof pl.timeout_ms === "number" ? pl.timeout_ms : undefined,
  });
}

/**
 * Handle media_generate_poll control operation.
 */
export async function handleMediaGeneratePoll(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  const pl = payloadObject(req);
  const providerId = pl.provider_id;
  const operationId = pl.operation_id;
  if (typeof providerId !== "string" || !providerId) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "media_generate_poll requires provider_id");
  }
  if (typeof operationId !== "string" || !operationId) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "media_generate_poll requires operation_id",
    );
  }
  const mediaGenConfig2 = (ctx.config as any).mediaGeneration;
  if (!mediaGenConfig2) {
    return { status: "error", error: `Provider not found: ${providerId}` };
  }
  const svc2 = (ctx.createMediaGenerationService ?? MediaGenerationService.fromConfig)(
    mediaGenConfig2,
  );
  return svc2.poll({
    provider_id: providerId,
    operation_id: operationId,
    output_path: typeof pl.output_path === "string" ? pl.output_path : undefined,
  });
}
