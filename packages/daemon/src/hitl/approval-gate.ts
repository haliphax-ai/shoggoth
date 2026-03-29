import type { HitlRiskTier } from "@shoggoth/shared";

const TIER_RANK: Record<HitlRiskTier, number> = {
  safe: 0,
  caution: 1,
  critical: 2,
};

/**
 * Most permissive `bypassUpTo` among roles the principal holds. Unmatched roles contribute nothing;
 * baseline is `safe` (only the safe tier may run without HITL unless a role grants more).
 */
export function effectiveBypassUpTo(
  principalRoles: readonly string[],
  roleBypassUpTo: Readonly<Record<string, HitlRiskTier>>,
): HitlRiskTier {
  let best: HitlRiskTier = "safe";
  let bestRank = TIER_RANK[best];
  for (const role of principalRoles) {
    const t = roleBypassUpTo[role];
    if (t !== undefined && TIER_RANK[t] > bestRank) {
      best = t;
      bestRank = TIER_RANK[t];
    }
  }
  return best;
}

/** True when classified risk is strictly above what the effective bypass allows. */
export function requiresHumanApproval(tier: HitlRiskTier, bypassUpTo: HitlRiskTier): boolean {
  return TIER_RANK[tier] > TIER_RANK[bypassUpTo];
}
