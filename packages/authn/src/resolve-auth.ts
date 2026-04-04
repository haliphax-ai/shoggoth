/**
 * Map WireAuth + connection context → AuthenticatedPrincipal (authn only; policy authorizes).
 */

import type { AuthenticatedPrincipal } from "./principal";
import type { WireAuth } from "./wire-auth";
import { validateOperatorToken } from "./operator-token";
import type { AgentTokenStore } from "./agent-token";
import { agentPrincipalFromToken } from "./agent-token";

export type ResolveAuthContext = {
  operatorTokenSecret?: string;
  agentTokenStore: AgentTokenStore;
};

export function resolveAuthenticatedPrincipal(
  auth: WireAuth,
  ctx: ResolveAuthContext,
): AuthenticatedPrincipal | null {
  if (auth.kind === "operator_token") {
    if (!ctx.operatorTokenSecret) return null;
    if (!validateOperatorToken(ctx.operatorTokenSecret, auth.token)) return null;
    return {
      kind: "operator",
      operatorId: "local-operator",
      roles: ["admin"],
      source: "cli_operator_token",
    };
  }
  if (auth.kind === "agent") {
    if (!ctx.agentTokenStore.validate(auth.token, auth.session_id)) return null;
    return agentPrincipalFromToken(auth.session_id);
  }
  return null;
}
