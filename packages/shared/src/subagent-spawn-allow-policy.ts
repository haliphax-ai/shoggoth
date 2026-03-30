import type { ShoggothAgentEntry, ShoggothConfig } from "./schema.js";

type SubagentSpawnAllowCfgPick = Pick<ShoggothConfig, "subagentSpawnAllow" | "agents">;

function perSenderSubagentSpawnAllow(
  cfg: SubagentSpawnAllowCfgPick,
  senderAgentId: string,
): ShoggothAgentEntry["subagentSpawnAllow"] {
  const entry = cfg.agents?.list?.[senderAgentId.trim()];
  return entry?.subagentSpawnAllow;
}

/**
 * Merges top-level `subagentSpawnAllow.allow` with `agents.list.<senderId>.subagentSpawnAllow.allow`
 * (deduped order-preserving).
 */
export function mergeSubagentSpawnAllowPatterns(
  cfg: SubagentSpawnAllowCfgPick,
  senderAgentId: string,
): string[] {
  const globalAllow = cfg.subagentSpawnAllow?.allow ?? [];
  const per = perSenderSubagentSpawnAllow(cfg, senderAgentId)?.allow ?? [];
  const merged = [...globalAllow, ...per];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of merged) {
    const t = String(x).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** True if either global or per-sender `subagentSpawnAllow` is present in config. */
export function hasExplicitSubagentSpawnAllowConfig(
  cfg: SubagentSpawnAllowCfgPick,
  senderAgentId: string,
): boolean {
  if (cfg.subagentSpawnAllow !== undefined) return true;
  return perSenderSubagentSpawnAllow(cfg, senderAgentId) !== undefined;
}

/**
 * Effective allowlist of logical agent ids for which the sender may spawn subagents (child sessions
 * carry the same agent id as the parent today). When no `subagentSpawnAllow` exists globally or on
 * `agents.list.<senderId>`, this is `[senderAgentId]` only (spawn only “as” own agent id).
 */
export function effectiveSubagentSpawnAllowedAgentIds(
  cfg: SubagentSpawnAllowCfgPick,
  senderAgentId: string,
): string[] {
  const sender = senderAgentId.trim();
  if (!sender) return [];
  if (!hasExplicitSubagentSpawnAllowConfig(cfg, sender)) {
    return [sender];
  }
  return mergeSubagentSpawnAllowPatterns(cfg, sender);
}

/**
 * Whether an **agent** principal may invoke `subagent_spawn` (allowlist only; combine with
 * {@link effectiveSpawnSubagentsEnabled} separately). Operators are not checked here.
 *
 * The sender may spawn only when their logical agent id is among the effective allowed ids (see
 * {@link effectiveSubagentSpawnAllowedAgentIds}) or `"*"` is present in that list.
 */
export function agentMayInvokeSubagentSpawnByAllowlist(
  cfg: SubagentSpawnAllowCfgPick,
  logicalAgentId: string,
): boolean {
  const sender = logicalAgentId.trim();
  const patterns = effectiveSubagentSpawnAllowedAgentIds(cfg, sender);
  if (patterns.length === 0) {
    return false;
  }
  for (const p of patterns) {
    if (p === "*") return true;
    if (p === sender) return true;
  }
  return false;
}
