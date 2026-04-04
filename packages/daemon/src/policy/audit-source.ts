import type { AuthenticatedPrincipal } from "@shoggoth/authn";

/**
 * Values stored in `audit_log.source`.
 */
export type AuditLogSource = "cli_operator_token" | "agent" | "system";

export function auditSourceForPrincipal(principal: AuthenticatedPrincipal): AuditLogSource {
  if (principal.kind === "system") return "system";
  if (principal.kind === "agent") return "agent";
  return "cli_operator_token";
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
