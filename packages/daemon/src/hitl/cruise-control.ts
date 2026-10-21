import type { ShoggothConfig, CruiseControlPolicy } from "@shoggoth/shared";
import type { CruiseControlDecision } from "@shoggoth/shared";
import { getLogger } from "../logging.js";
import { DecisionService } from "../decision/decision-service.js";

const log = getLogger("cruise-control");

// ---------------------------------------------------------------------------
// Cruise control — per-session HITL auto-pilot.
//
// When cruise control is active for a session, every HITL approval request
// that does not pass configured auto-approvals is routed to a tiny
// decision-driven judge agent (TypeSafe System One) instead of the operator.
// The judge approves or denies according to the operator's guidance; when an
// escalation route is configured and the judge has enough doubt, the request
// escalates to true HITL as usual.
// ---------------------------------------------------------------------------

/** Default minimum score the escalation route must reach to escalate. */
export const DEFAULT_CRUISE_ESCALATE_MIN_SCORE = 0.34;

/** Judge request timeout — a hung decision model must not stall the tool loop. */
const CRUISE_JUDGE_TIMEOUT_MS = 30_000;

/** Question id used for the judge decision. */
const DECISION_QUESTION_ID = "decision";

/** Choice-question route names. */
const APPROVE_ROUTE = "approve";
const DENY_ROUTE = "deny";
const ESCALATE_ROUTE = "escalate";

export interface CruiseControlStore {
  get(sessionId: string): CruiseControlPolicy | undefined;
  set(sessionId: string, policy: CruiseControlPolicy): void;
  clear(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
}

export function createCruiseControlStore(): CruiseControlStore {
  const policies = new Map<string, CruiseControlPolicy>();
  return {
    get: (sessionId) => policies.get(sessionId),
    set: (sessionId, policy) => {
      policies.set(sessionId, policy);
    },
    clear: (sessionId) => policies.delete(sessionId),
    isActive: (sessionId) => policies.has(sessionId),
  };
}

// ---------------------------------------------------------------------------
// Decision banners — in-turn operator visibility.
//
// The judge decides mid-turn, so verdicts are folded into the active turn's
// output as blockquote banners (via the active turn surface) instead of
// being buried in logs.
// ---------------------------------------------------------------------------

/** Cap on the extracted command shown in a decision banner. */
const BANNER_COMMAND_MAX_CHARS = 60;

/**
 * Extract a command-shaped preview from a tool call's args for decision
 * banners: an `argv` array (joined) or a `command` string. Backticks are
 * quoted out and newlines collapsed so the banner's code span stays intact.
 * Returns undefined when args are unparseable or carry no command.
 */
export function extractCruiseToolCommand(argsJson: string): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  const obj = args as { argv?: unknown; command?: unknown };
  let command: string | undefined;
  if (
    Array.isArray(obj?.argv) &&
    obj.argv.length > 0 &&
    obj.argv.every((a) => typeof a === "string")
  ) {
    command = obj.argv.join(" ");
  } else if (typeof obj?.command === "string") {
    command = obj.command;
  }
  if (command === undefined) return undefined;
  const normalized = command.replace(/`/g, "'").replace(/\r?\n/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Decision-word segment of the banner, per verdict. */
const CRUISE_BANNER_LABEL: Record<CruiseControlDecision, string> = {
  approve: "✅ Cruise control **approved**",
  deny: "❌ Cruise control **denied**",
  escalate: "⬆️ Cruise control **elevated**",
};

/**
 * Build the in-turn decision banner, e.g.
 * `> 🚗✅ Cruise control **approved** `builtin-exec: git status``.
 * The monospace span carries the tool name plus the extracted command
 * (truncated) when one was provided.
 */
export function buildCruiseControlBanner(input: {
  readonly decision: CruiseControlDecision;
  readonly toolName: string;
  /** Extracted command preview (see {@link extractCruiseToolCommand}). */
  readonly command?: string;
}): string {
  const command = input.command
    ? input.command.length > BANNER_COMMAND_MAX_CHARS
      ? `${input.command.slice(0, BANNER_COMMAND_MAX_CHARS)}…`
      : input.command
    : undefined;
  const span = command ? `${input.toolName}: ${command}` : input.toolName;
  return `> 🚗${CRUISE_BANNER_LABEL[input.decision]} \`${span}\``;
}

/**
 * Warnings surfaced to the operator when cruise control is activated: a
 * missing model is logged and shown because every request would otherwise
 * silently degrade to true HITL.
 */
export function cruiseControlActivationWarnings(
  config: ShoggothConfig,
  policy: CruiseControlPolicy,
): string[] {
  const warnings: string[] = [];
  const defaultModel = config.agents?.cruiseControl?.model;
  const effectiveModel = policy.model ?? defaultModel;
  if (!effectiveModel) {
    warnings.push(
      "no cruise control model provided and no default is configured (agents.cruiseControl.model); HITL requests will escalate to true HITL",
    );
    return warnings;
  }
  const decisionModels = Object.entries(config.decision?.providers ?? {}).flatMap(([id, p]) =>
    (p.models ?? []).map((m) => `${id}/${m.name}`),
  );
  if (decisionModels.length === 0) {
    warnings.push("decision support is not configured; HITL requests will escalate to true HITL");
  } else if (!decisionModels.includes(effectiveModel)) {
    warnings.push(
      `cruise control model ${effectiveModel} is not listed in the decision provider config; HITL requests will escalate to true HITL`,
    );
  }
  return warnings;
}

export interface CruiseJudgeInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly argsJson: string;
  readonly policy: CruiseControlPolicy;
  readonly config: ShoggothConfig;
}

/**
 * Run the cruise control judge for one HITL request.
 *
 * - No escalation guidance → `noul` question; the yes/no guidance map to the
 *   true/false criteria and the returned probability decides.
 * - Escalation guidance → `choice` question with approve/deny/escalate routes;
 *   the escalation route scoring at or above `escalateMinScore` escalates even
 *   when it is not the highest-scoring option (enough doubt).
 *
 * Any failure (no model, decision error, timeout, missing answer) falls back
 * to `"escalate"` so the request reaches true HITL instead of being silently
 * auto-decided.
 */
export async function judgeCruiseControl(input: CruiseJudgeInput): Promise<CruiseControlDecision> {
  const { policy, config } = input;
  const model = policy.model ?? config.agents?.cruiseControl?.model;
  if (!model) {
    log.warn("cruise_judge_no_model", { sessionId: input.sessionId });
    return "escalate";
  }
  if (Object.keys(config.decision?.providers ?? {}).length === 0) {
    log.warn("cruise_judge_decision_unconfigured", { sessionId: input.sessionId });
    return "escalate";
  }

  let args: unknown;
  try {
    args = JSON.parse(input.argsJson);
  } catch {
    args = input.argsJson;
  }
  const state = { tool: input.toolName, arguments: args };
  const hasEscalate = Boolean(policy.escalate?.trim());
  const questions = hasEscalate
    ? {
        [DECISION_QUESTION_ID]: {
          type: "choice",
          instructions: "Decide what should happen to this pending tool call approval request.",
          criteria: {
            [APPROVE_ROUTE]: policy.yes,
            [DENY_ROUTE]: policy.no,
            [ESCALATE_ROUTE]: policy.escalate,
          },
        },
      }
    : {
        [DECISION_QUESTION_ID]: {
          type: "noul",
          instructions: "Should this pending tool call approval request be approved?",
          criteria: {
            true: policy.yes,
            false: policy.no,
          },
        },
      };

  const svc = DecisionService.fromConfig(config.decision ?? { providers: {} });
  const res = await svc.evaluate({
    model,
    state,
    questions,
    timeout_ms: CRUISE_JUDGE_TIMEOUT_MS,
  });
  if (res.status !== "complete") {
    log.warn("cruise_judge_failed", {
      sessionId: input.sessionId,
      toolName: input.toolName,
      error: res.error,
    });
    return "escalate";
  }

  const answer = res.answers[DECISION_QUESTION_ID] as
    | { type?: string; noul?: number; choice?: string; distribution?: Record<string, number> }
    | undefined;
  if (!answer) {
    log.warn("cruise_judge_missing_answer", {
      sessionId: input.sessionId,
      toolName: input.toolName,
    });
    return "escalate";
  }

  let decision: CruiseControlDecision;
  if (hasEscalate) {
    // Escalation wins on doubt: a route score at or above the configured
    // minimum escalates even when approve/deny score higher.
    const escalateScore =
      typeof answer.distribution?.[ESCALATE_ROUTE] === "number"
        ? answer.distribution[ESCALATE_ROUTE]
        : answer.choice === ESCALATE_ROUTE
          ? 1
          : 0;
    const minScore =
      config.agents?.cruiseControl?.escalateMinScore ?? DEFAULT_CRUISE_ESCALATE_MIN_SCORE;
    if (escalateScore >= minScore) {
      decision = "escalate";
    } else if (answer.choice === APPROVE_ROUTE) {
      decision = "approve";
    } else if (answer.choice === DENY_ROUTE) {
      decision = "deny";
    } else {
      decision = "escalate";
    }
  } else {
    const score = typeof answer.noul === "number" ? answer.noul : 0;
    decision = score >= 0.5 ? "approve" : "deny";
  }

  log.info("cruise_judge_decision", {
    sessionId: input.sessionId,
    toolName: input.toolName,
    decision,
  });
  return decision;
}
