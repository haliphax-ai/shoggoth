import { parseAgentSessionUrn, type HitlRiskTier, type ShoggothConfig } from "@shoggoth/shared";

/**
 * Resolve the effective HITL bypass tier for a session.
 * Checks agents.list.<agentId>.hitl.bypassUpTo first, falls back to hitl.bypassUpTo.
 */
export function resolveSessionBypassUpTo(
  sessionId: string,
  config: ShoggothConfig,
): HitlRiskTier {
  const p = parseAgentSessionUrn(sessionId.trim());
  if (p) {
    const agentHitl = config.agents?.list?.[p.agentId]?.hitl;
    if (agentHitl?.bypassUpTo !== undefined) return agentHitl.bypassUpTo;
  }
  return config.hitl.bypassUpTo;
}
