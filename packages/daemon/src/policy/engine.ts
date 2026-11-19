import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type {
  ShoggothAgentsConfig,
  ShoggothPolicyConfig,
  ShoggothToolRules,
} from "@shoggoth/shared";
import { resolveAgentIdFromSessionId } from "@shoggoth/shared";
import { isGlobPattern, toolIdGlobMatches } from "../sessions/tool-id-glob";
import { INTEGRATION_CONTROL_OPS, type IntegrationControlOp } from "../control/op-registry";

export { INTEGRATION_CONTROL_OPS } from "../control/op-registry";

export type PolicyAction = "control.invoke" | "tool.invoke";

export type PolicyCheckInput = {
  readonly principal: AuthenticatedPrincipal;
  readonly action: PolicyAction;
  /** Control op name (e.g. `ping`) or tool name. */
  readonly resource: string;
};

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

const EMPTY_RULES: ShoggothToolRules = { allow: [], deny: [], review: [] };

/**
 * Ops recognized at the wire layer. Registry ops are derived from the
 * integration-op handler registry so the two cannot drift; `ping`, `version`,
 * `health`, and `agent_ping` are handled directly in the control-plane
 * dispatcher and are listed here explicitly.
 *
 * Unknown names are rejected with `ERR_UNKNOWN_OP` before policy evaluation,
 * so an op missing here is unreachable over the wire even if policy allows it.
 */
export const DEFINED_CONTROL_OPS: readonly string[] = [
  "ping",
  "version",
  "health",
  "agent_ping",
  ...INTEGRATION_CONTROL_OPS,
];

/**
 * A control op that the wire layer can dispatch. The op may still be rejected
 * at dispatch (principal restrictions, feature gates), but policy for a
 * defined op is live configuration rather than dead surface.
 */
type DefinedControlOp = "ping" | "version" | "health" | "agent_ping" | IntegrationControlOp;

/**
 * Exact-string gate against the defined-op set. Used before policy evaluation
 * so unknown ops are rejected with `ERR_UNKNOWN_OP` (audited as `unknown_op`)
 * before any policy lookup.
 */
export function isDefinedControlOp(op: string): op is DefinedControlOp {
  return (DEFINED_CONTROL_OPS as readonly string[]).includes(op);
}

/**
 * Check if a resource matches any entry in a rule list.
 *
 * Compound resource matching (e.g. `exec:curl`):
 *   - `exec:curl` matches exact `exec:curl`
 *   - `exec:*`    matches any `exec:<sub>`
 *   - `exec`      (bare) matches `exec:<sub>` for any sub (backward compat)
 *   - `exec:curl` does NOT match bare `exec` (specific sub-resource rule doesn't cover the whole tool)
 *   - `*`         matches everything
 */
function matchesRule(resource: string, rules: readonly string[] | undefined): boolean {
  // Defensive: a partial policy config (e.g. hot-reloaded fragment missing a
  // tier list) must not crash the turn with `Cannot read properties of
  // undefined (reading 'includes')` — treat a missing list as empty.
  if (!rules) return false;
  if (rules.includes("*")) return true;
  if (rules.includes(resource)) return true;

  // Compound resource: check wildcard and bare-tool rules
  const colonIdx = resource.indexOf(":");
  if (colonIdx > 0) {
    const toolBase = resource.slice(0, colonIdx);
    // `exec:*` matches any `exec:<sub>`
    if (rules.includes(`${toolBase}:*`)) return true;
    // bare `exec` matches `exec:<sub>` (backward compat)
    if (rules.includes(toolBase)) return true;
  }

  return false;
}

function matchesAllow(resource: string, allow: readonly string[] | undefined): boolean {
  return matchesRule(resource, allow);
}

/**
 * Glob pass for the deny/review tiers (operator ruling): entries containing
 * `*`/`?` are matched against the full compound resource with the shared
 * tool-id glob matcher (`packages/daemon/src/sessions/tool-id-glob.ts`).
 * Exact/`tool:*`/bare/`*` entries are unaffected — this pass only adds
 * matches for wildcard entries that `matchesRule` misses. Non-matching or
 * missing lists return false (fail toward allow, like `matchesRule`).
 */
function matchesGlobRule(resource: string, rules: readonly string[] | undefined): boolean {
  if (!rules) return false;
  for (const rule of rules) {
    if (isGlobPattern(rule) && toolIdGlobMatches(rule, resource)) return true;
  }
  return false;
}

function matchesDeny(resource: string, deny: readonly string[] | undefined): boolean {
  return matchesRule(resource, deny) || matchesGlobRule(resource, deny);
}

function matchesReview(resource: string, review: readonly string[] | undefined): boolean {
  if (!review || review.length === 0) return false;
  return matchesRule(resource, review) || matchesGlobRule(resource, review);
}

/**
 * Default-deny: allowed only if an allow rule matches and no deny rule matches.
 * Evaluation order: deny → review → allow → default_deny.
 * `*` in allow permits any resource not explicitly denied; `*` in deny blocks all.
 * Deny and review entries may also be globs (`*`/`?`, e.g. `kanban-*`) matched
 * against the full compound resource via the shared tool-id glob matcher.
 */
export function evaluateRules(resource: string, rules: ShoggothToolRules): PolicyDecision {
  if (matchesDeny(resource, rules.deny)) {
    return { allow: false, reason: "explicit_deny" };
  }
  if (matchesReview(resource, rules.review)) {
    return { allow: false, reason: "requires_review" };
  }
  if (matchesAllow(resource, rules.allow)) {
    return { allow: true };
  }
  return { allow: false, reason: "default_deny" };
}

export type PolicyEngine = {
  check(input: PolicyCheckInput): PolicyDecision;
  readonly config: ShoggothPolicyConfig;
};

/**
 * Merge global tool rules with optional per-agent partial overrides.
 * Per-agent fields replace the corresponding global field when present.
 */
export function resolveEffectiveToolRules(
  global: ShoggothToolRules,
  perAgent: Partial<ShoggothToolRules> | undefined,
): ShoggothToolRules {
  if (!perAgent) return global;
  return {
    allow: perAgent.allow ?? global.allow,
    deny: perAgent.deny ?? global.deny,
    review: perAgent.review ?? global.review,
  };
}

export function createPolicyEngine(
  config: ShoggothPolicyConfig,
  agents?: ShoggothAgentsConfig,
): PolicyEngine {
  return {
    config,
    check(input: PolicyCheckInput): PolicyDecision {
      const { principal, action, resource } = input;

      if (principal.kind === "system") {
        return { allow: true };
      }

      if (principal.kind === "operator") {
        if (action === "control.invoke") {
          return evaluateRules(resource, config.operator.controlOps);
        }
        if (action === "tool.invoke") {
          return evaluateRules(resource, config.operator.tools);
        }
        return { allow: false, reason: "unknown_action" };
      }

      if (principal.kind === "agent") {
        if (action === "control.invoke") {
          return evaluateRules(resource, config.agent.controlOps);
        }
        if (action === "tool.invoke") {
          const agentId = resolveAgentIdFromSessionId(principal.sessionId);
          const perAgent = agentId ? agents?.list?.[agentId]?.policy?.tools : undefined;
          const effective = resolveEffectiveToolRules(config.agent.tools, perAgent);
          return evaluateRules(resource, effective);
        }
        return { allow: false, reason: "unknown_action" };
      }

      return { allow: false, reason: "unknown_principal" };
    },
  };
}

/**
 * Forwards `check` and `config` to the engine returned by `getEngine()` so policy can be
 * swapped in-process (config hot-reload) without recreating listeners.
 */
export function createDelegatingPolicyEngine(getEngine: () => PolicyEngine): PolicyEngine {
  return {
    get config(): ShoggothPolicyConfig {
      return getEngine().config;
    },
    check(input: PolicyCheckInput): PolicyDecision {
      return getEngine().check(input);
    },
  };
}

/** Useful when building tests or minimal engines without full config defaults. */
export function emptyPolicyConfig(): ShoggothPolicyConfig {
  return {
    operator: { controlOps: { ...EMPTY_RULES }, tools: { ...EMPTY_RULES } },
    agent: { controlOps: { ...EMPTY_RULES }, tools: { ...EMPTY_RULES } },
    auditRedaction: { jsonPaths: [] },
  };
}
