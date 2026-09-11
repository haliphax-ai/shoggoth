import { z } from "zod";

// ---------------------------------------------------------------------------
// HITL
// ---------------------------------------------------------------------------

export const hitlRiskTierSchema = z.enum(["safe", "caution", "critical", "never"]);

export type HitlRiskTier = z.infer<typeof hitlRiskTierSchema>;

export const shoggothHitlConfigSchema = z
  .object({
    defaultApprovalTimeoutMs: z.number().int().positive(),
    toolRisk: z.record(z.string(), hitlRiskTierSchema),
    /** Default highest tier that may run without human approval (inclusive). Per-agent overrides live in agents.list.<id>.hitl.bypassUpTo. */
    bypassUpTo: hitlRiskTierSchema,
  })
  .strict();

export type ShoggothHitlConfig = z.infer<typeof shoggothHitlConfigSchema>;

export const DEFAULT_HITL_CONFIG: ShoggothHitlConfig = {
  defaultApprovalTimeoutMs: 300_000,
  toolRisk: {
    "builtin-read": "safe",
    "builtin-write": "caution",
    "builtin-exec": "critical",
    "builtin-memory-search": "safe",
    "builtin-memory-ingest": "caution",
    "builtin-session-list": "safe",
    "builtin-session-send": "caution",
    "builtin-session-query": "safe",
    "builtin-subagent": "caution",
    "builtin-message": "caution",
    "builtin-config-request": "never",
    "builtin-media-generate": "caution",
    "builtin-vault": "caution",
  },
  /**
   * Default bypass tier for all agents. Per-agent overrides in agents.list.<id>.hitl.bypassUpTo.
   */
  bypassUpTo: "safe",
};