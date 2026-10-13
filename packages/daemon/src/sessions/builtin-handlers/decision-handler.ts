// ---------------------------------------------------------------------------
// builtin-decision — evaluate a state against typed questions (`noul`,
// `choice`, `score`) via a TypeSafe System One classifier model, using the
// decision_evaluate control plane op.
// ---------------------------------------------------------------------------

import type {
  BuiltinToolRegistry,
  BuiltinToolContext,
  BuiltinToolResult,
} from "../builtin-tool-registry";
import { getLogger } from "../../logging.js";

const log = getLogger("decision-handler");

export function register(registry: BuiltinToolRegistry): void {
  registry.register("decision", decisionHandler);
}

async function decisionHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const model = args.model as string | undefined;
  const state = args.state;
  const questions = args.questions as Record<string, unknown> | undefined;

  // model is optional — falls back to the configured decision defaultModel
  if (model !== undefined && (typeof model !== "string" || !model)) {
    return { resultJson: JSON.stringify({ error: "model must be a non-empty string" }) };
  }
  if (state === undefined || state === null) {
    return { resultJson: JSON.stringify({ error: "state is required" }) };
  }
  if (
    !questions ||
    typeof questions !== "object" ||
    Array.isArray(questions) ||
    Object.keys(questions).length === 0
  ) {
    return {
      resultJson: JSON.stringify({
        error: "questions must be a non-empty object of typed questions",
      }),
    };
  }

  // Check that decision support is configured
  const hasDecisionConfig = (ctx.config.decision?.providers ?? []).some(
    (p: { models?: unknown[] }) => (p.models?.length ?? 0) > 0,
  );
  if (!hasDecisionConfig) {
    return {
      resultJson: JSON.stringify({
        error: "Decision not configured. Add providers and models to decision config.",
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
    result = (await invoker(ctx.sessionId, "decision_evaluate", {
      ...(model ? { model } : {}),
      state,
      questions,
      ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
    })) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("decision_evaluate_op_failed", { error: msg });
    return { resultJson: JSON.stringify({ error: msg }) };
  }

  return { resultJson: JSON.stringify(result ?? { error: "unknown error" }) };
}
