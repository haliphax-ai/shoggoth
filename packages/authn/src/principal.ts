/**
 * Authenticated principals for Shoggoth (authentication layer).
 * The policy engine uses these with action/resource for authorization.
 */

export type OperatorPrincipal = {
  kind: "operator";
  operatorId: string;
  roles: string[];
  source: "cli_operator_token";
};

export type AgentPrincipal = {
  kind: "agent";
  sessionId: string;
  agentId?: string;
  source: "agent";
};

export type SystemPrincipal = {
  kind: "system";
  component: string;
  source: "system";
};

export type AuthenticatedPrincipal = OperatorPrincipal | AgentPrincipal | SystemPrincipal;

/**
 * Convenience union of every source literal above — derived from the principal
 * types so it can never drift out of sync with them.
 */
export type AuthSource = AuthenticatedPrincipal["source"];
