import { parseAgentSessionUrn } from "@shoggoth/shared";

/**
 * Principal role id for tool-loop HITL when the session id is not a normal agent session URN.
 * With no matching `hitl.agentBypassUpTo` entry, the effective bypass tier stays at baseline `safe`.
 */
export const SHOGGOTH_HITL_UNKNOWN_SESSION_AGENT = "agent:unknown";

/**
 * Roles used only to decide **whether** a tool call needs human approval before execution.
 * The human operator approves via CLI / notify channels; they are not a principal here.
 *
 * Returns `agent:<agentId>` parsed from the session URN (`agent:<agentId>:<platform>:<leaf>…`).
 */
export function resolveSessionAgentHitlPrincipalRoles(sessionId: string): string[] {
  const p = parseAgentSessionUrn(sessionId.trim());
  if (!p) return [SHOGGOTH_HITL_UNKNOWN_SESSION_AGENT];
  return [`agent:${p.agentId}`];
}
