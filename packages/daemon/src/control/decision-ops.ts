/**
 * Control plane decision and rerank operations.
 */

import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { WireRequest } from "@shoggoth/authn";
import { DecisionService } from "../decision/decision-service";
import { RerankService } from "../rerank/rerank-service";
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
 * Handle decision_evaluate control operation.
 */
export async function handleDecisionEvaluate(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  // Feature gating: with no decision provider that has models, the op is
  // indistinguishable from a nonexistent one (undefined → ERR_UNKNOWN_OP).
  const decisionConfig = (ctx.config as any).decision;
  const decisionEnabled = (
    Object.values(decisionConfig?.providers ?? {}) as Array<{
      models?: Record<string, unknown>;
    }>
  ).some((p) => Object.keys(p.models ?? {}).length > 0);
  if (!decisionEnabled) {
    return undefined;
  }
  if (principal.kind !== "agent" && principal.kind !== "operator") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "decision_evaluate requires agent or operator principal",
    );
  }
  const pl = payloadObject(req);
  // model is optional — falls back to the configured decision defaultModel
  const modelRaw = pl.model;
  if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== "string" || !modelRaw)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "decision_evaluate model must be a non-empty string",
    );
  }
  const model = typeof modelRaw === "string" && modelRaw ? modelRaw : undefined;
  if (pl.state === undefined || pl.state === null) {
    throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "decision_evaluate requires state");
  }
  const questions = pl.questions;
  if (
    !questions ||
    typeof questions !== "object" ||
    Array.isArray(questions) ||
    Object.keys(questions as object).length === 0
  ) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "decision_evaluate requires a non-empty questions object",
    );
  }
  const svc = DecisionService.fromConfig(decisionConfig);
  return svc.evaluate({
    model: model,
    state: pl.state,
    questions: questions as Record<string, unknown>,
    timeout_ms: typeof pl.timeout_ms === "number" ? pl.timeout_ms : undefined,
  });
}

/**
 * Handle rerank_documents control operation.
 */
export async function handleRerankDocuments(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  // Feature gating: with no rerank provider that has models, the op is
  // indistinguishable from a nonexistent one (undefined → ERR_UNKNOWN_OP).
  const rerankConfig = ctx.config.rerank;
  const rerankEnabled = Object.values(rerankConfig?.providers ?? {}).some(
    (p) => Object.keys(p.models ?? {}).length > 0,
  );
  if (!rerankEnabled) {
    return undefined;
  }
  if (principal.kind !== "agent" && principal.kind !== "operator") {
    throw new IntegrationOpError(
      "ERR_FORBIDDEN",
      "rerank_documents requires agent or operator principal",
    );
  }
  const pl = payloadObject(req);
  // model is optional — falls back to the configured rerank defaultModel
  const modelRaw = pl.model;
  if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== "string" || !modelRaw)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "rerank_documents model must be a non-empty string",
    );
  }
  const model = typeof modelRaw === "string" && modelRaw ? modelRaw : undefined;
  const queryRaw = pl.query;
  if (typeof queryRaw !== "string" || !queryRaw.trim()) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "rerank_documents requires a non-empty query string",
    );
  }
  const docsRaw = pl.documents;
  if (!Array.isArray(docsRaw) || docsRaw.length === 0) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "rerank_documents requires a non-empty documents array",
    );
  }
  if (!docsRaw.every((d) => typeof d === "string" && d.length > 0)) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "rerank_documents documents must be non-empty strings",
    );
  }
  const topNRaw = pl.top_n;
  if (
    topNRaw !== undefined &&
    topNRaw !== null &&
    (typeof topNRaw !== "number" || !Number.isFinite(topNRaw) || topNRaw < 1)
  ) {
    throw new IntegrationOpError(
      "ERR_INVALID_PAYLOAD",
      "rerank_documents top_n must be a positive number",
    );
  }
  const svc = (ctx.createRerankService ?? RerankService.fromConfig)(rerankConfig!);
  return svc.rerank({
    model: model,
    query: queryRaw,
    documents: docsRaw as string[],
    top_n: typeof topNRaw === "number" ? topNRaw : undefined,
    timeout_ms: typeof pl.timeout_ms === "number" ? pl.timeout_ms : undefined,
  });
}
