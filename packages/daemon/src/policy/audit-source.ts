import type { AuthenticatedPrincipal, OperatorPrincipal } from "@shoggoth/authn";

/**
 * Values stored in `audit_log.source` (SHOGGOTH-PLAN: cli_socket, agent, system; plus operator token path).
 */
export type AuditLogSource = "cli_socket" | "cli_operator_token" | "agent" | "system";

export function auditSourceForPrincipal(principal: AuthenticatedPrincipal): AuditLogSource {
  if (principal.kind === "system") return "system";
  if (principal.kind === "agent") return "agent";
  const op = principal as OperatorPrincipal;
  if (op.source === "cli_operator_token") return "cli_operator_token";
  return "cli_socket";
}

export function principalAuditFields(principal: AuthenticatedPrincipal): {
  principalKind: string;
  principalId: string;
  sessionId?: string;
  agentId?: string;
  peerUid?: number;
  peerGid?: number;
  peerPid?: number;
} {
  if (principal.kind === "operator") {
    return {
      principalKind: "operator",
      principalId: principal.operatorId,
      peerUid: principal.peer?.uid,
      peerGid: principal.peer?.gid,
      peerPid: principal.peer?.pid,
    };
  }
  if (principal.kind === "agent") {
    return {
      principalKind: "agent",
      principalId: principal.sessionId,
      sessionId: principal.sessionId,
      agentId: principal.agentId,
    };
  }
  return {
    principalKind: "system",
    principalId: principal.component,
  };
}
