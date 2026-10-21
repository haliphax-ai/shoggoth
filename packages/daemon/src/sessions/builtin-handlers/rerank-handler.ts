// ---------------------------------------------------------------------------
// builtin-rerank — score and order documents against a query via a
// Cohere-style rerank model, using the rerank_documents control plane op.
// ---------------------------------------------------------------------------

import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry";
import { getLogger } from "../../logging.js";

const log = getLogger("rerank-handler");

export function register(registry: BuiltinToolRegistry): void {
  registry.register("rerank", rerankHandler);
}

async function rerankHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const model = args.model as string | undefined;
  const query = args.query as string | undefined;
  const documents = args.documents as unknown;
  const topN = args.top_n;

  // model is optional — falls back to the configured rerank defaultModel
  if (model !== undefined && (typeof model !== "string" || !model)) {
    return { resultJson: JSON.stringify({ error: "model must be a non-empty string" }) };
  }
  if (typeof query !== "string" || !query.trim()) {
    return { resultJson: JSON.stringify({ error: "query must be a non-empty string" }) };
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    return {
      resultJson: JSON.stringify({
        error: "documents must be a non-empty array of strings",
      }),
    };
  }
  if (!documents.every((d) => typeof d === "string" && d.length > 0)) {
    return {
      resultJson: JSON.stringify({ error: "every document must be a non-empty string" }),
    };
  }
  if (topN !== undefined && (typeof topN !== "number" || !Number.isFinite(topN) || topN < 1)) {
    return { resultJson: JSON.stringify({ error: "top_n must be a positive number" }) };
  }

  // Check that rerank support is configured
  const hasRerankConfig = Object.values(ctx.config.rerank?.providers ?? {}).some(
    (p) => Object.keys(p.models ?? {}).length > 0,
  );
  if (!hasRerankConfig) {
    return {
      resultJson: JSON.stringify({
        error: "Rerank not configured. Add providers and models to rerank config.",
      }),
    };
  }

  const invoker = ctx.getAgentIntegrationInvoker();
  if (!invoker) {
    return { resultJson: JSON.stringify({ error: "Integration invoker unavailable" }) };
  }

  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

  let result: Record<string, unknown>;
  try {
    result = (await invoker(ctx.sessionId, "rerank_documents", {
      ...(model ? { model } : {}),
      query,
      documents,
      ...(topN != null ? { top_n: topN } : {}),
      ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
    })) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("rerank_documents_op_failed", { error: msg });
    return { resultJson: JSON.stringify({ error: msg }) };
  }

  return { resultJson: JSON.stringify(result ?? { error: "unknown error" }) };
}
