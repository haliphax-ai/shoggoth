import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { ShoggothPolicyConfig, ShoggothToolRules } from "@shoggoth/shared";

export type PolicyAction = "control.invoke" | "tool.invoke";

export type PolicyCheckInput = {
  readonly principal: AuthenticatedPrincipal;
  readonly action: PolicyAction;
  /** Control op name (e.g. `ping`) or tool name. */
  readonly resource: string;
};

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

const EMPTY_RULES: ShoggothToolRules = { allow: [], deny: [] };

/** Ops the wire layer recognizes; unknown names stay `ERR_UNKNOWN_OP` before policy. */
export const DEFINED_CONTROL_OPS = [
  "ping",
  "version",
  "health",
  "agent_ping",
  "acpx_bind_get",
  "acpx_bind_set",
  "acpx_bind_delete",
  "acpx_bind_list",
  "acpx_agent_start",
  "acpx_agent_stop",
  "acpx_agent_list",
  "canvas_authorize",
  "hitl_pending_list",
  "hitl_pending_get",
  "hitl_pending_approve",
  "hitl_pending_deny",
  "hitl_clear",
  "mcp_http_cancel_request",
  "session_compact",
  "session_context_new",
  "session_context_reset",
  "session_context_status",
  "session_stats",
  "subagent_spawn",
  "session_inspect",
  "session_list",
  "session_send",
  "session_steer",
  "session_abort",
  "session_kill",
  "session_model",
  "config_show",
  "procman_list",
  "procman_restart",
  "procman_stop",
] as const;
export type DefinedControlOp = (typeof DEFINED_CONTROL_OPS)[number];

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
function matchesRule(resource: string, rules: readonly string[]): boolean {
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

function matchesAllow(resource: string, allow: readonly string[]): boolean {
  return matchesRule(resource, allow);
}

function matchesDeny(resource: string, deny: readonly string[]): boolean {
  return matchesRule(resource, deny);
}

/**
 * Default-deny: allowed only if an allow rule matches and no deny rule matches.
 * `*` in allow permits any resource not explicitly denied; `*` in deny blocks all.
 */
export function evaluateRules(resource: string, rules: ShoggothToolRules): PolicyDecision {
  if (matchesDeny(resource, rules.deny)) {
    return { allow: false, reason: "explicit_deny" };
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

export function createPolicyEngine(config: ShoggothPolicyConfig): PolicyEngine {
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
          return evaluateRules(resource, config.agent.tools);
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
