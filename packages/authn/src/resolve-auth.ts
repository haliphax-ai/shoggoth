/**
 * Map WireAuth + connection context → AuthenticatedPrincipal (authn only; policy authorizes).
 */

import type { AuthenticatedPrincipal, PeerCredentials } from "./principal";
import type { WireAuth } from "./wire-auth";
import type { OperatorMap } from "./operator-map";
import {
  operatorPrincipalFromPeer,
} from "./operator-map";
import { validateOperatorToken } from "./operator-token";
import type { AgentTokenStore } from "./agent-token";
import { agentPrincipalFromToken } from "./agent-token";

export type ResolveAuthContext = {
  peer: PeerCredentials;
  operatorMap: OperatorMap;
  operatorTokenSecret?: string;
  agentTokenStore: AgentTokenStore;
};

export function resolveAuthenticatedPrincipal(
  auth: WireAuth,
  ctx: ResolveAuthContext,
): AuthenticatedPrincipal | null {
  if (auth.kind === "operator_peercred") {
    return operatorPrincipalFromPeer(ctx.peer, ctx.operatorMap, "cli_socket");
  }
  if (auth.kind === "operator_token") {
    if (!ctx.operatorTokenSecret) return null;
    if (!validateOperatorToken(ctx.operatorTokenSecret, auth.token)) return null;
    return operatorPrincipalFromPeer(ctx.peer, ctx.operatorMap, "cli_operator_token");
  }
  if (auth.kind === "agent") {
    if (!ctx.agentTokenStore.validate(auth.token, auth.session_id)) return null;
    return agentPrincipalFromToken(auth.session_id);
  }
  return null;
}
