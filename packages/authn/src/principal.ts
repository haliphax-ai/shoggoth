/**
 * Authenticated principals for Shoggoth (authentication layer).
 * The policy engine uses these with action/resource for authorization.
 */

export type AuthSource = "cli_socket" | "cli_operator_token" | "agent" | "system";

export type PeerCredentials = {
  uid: number;
  gid: number;
  pid: number;
};

export type OperatorPrincipal = {
  kind: "operator";
  operatorId: string;
  roles: string[];
  source: "cli_socket" | "cli_operator_token";
  /** Present when source is cli_socket */
  peer?: PeerCredentials;
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

export type AuthenticatedPrincipal =
  | OperatorPrincipal
  | AgentPrincipal
  | SystemPrincipal;
