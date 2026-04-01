import type { HitlRiskTier } from "@shoggoth/shared";

const TIER_RANK: Record<HitlRiskTier, number> = {
  safe: 0,
  caution: 1,
  critical: 2,
  never: 3,
};

/** True when classified risk is strictly above what the effective bypass allows. */
export function requiresHumanApproval(tier: HitlRiskTier, bypassUpTo: HitlRiskTier): boolean {
  return TIER_RANK[tier] > TIER_RANK[bypassUpTo];
}
