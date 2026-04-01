import { DEFAULT_HITL_CONFIG, type HitlRiskTier } from "@shoggoth/shared";

export const DEFAULT_TOOL_RISK: Readonly<Record<string, HitlRiskTier>> = DEFAULT_HITL_CONFIG.toolRisk;

/**
 * Config-driven risk tier for a tool name. Direct map lookup only — all tool names
 * are expected in canonical namespaced form (e.g. `builtin.exec`).
 */
export function classifyToolRisk(
  toolName: string,
  toolRiskOverlay: Readonly<Record<string, HitlRiskTier>>,
): HitlRiskTier {
  const map: Record<string, HitlRiskTier> = { ...DEFAULT_TOOL_RISK, ...toolRiskOverlay };
  const direct = map[toolName];
  if (direct !== undefined) return direct;
  const wild = map["*"];
  if (wild !== undefined) return wild;
  return "caution";
}
