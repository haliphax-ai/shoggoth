import type { ShoggothConfig } from "./schema.js";

/**
 * Whether the agent id may use subagent-related builtins (`builtin-subagent`) and matching
 * control ops. Per-agent `agents.list.<id>.spawnSubagents` overrides top-level `spawnSubagents`
 * when set. Omitted booleans default to **true** (backward compatible).
 *
 * `subagent_spawn` is also gated by {@link agentMayInvokeSubagentSpawnByAllowlist} (default: spawn only
 * for the caller’s own agent id unless `subagentSpawnAllow` widens it).
 */
export function effectiveSpawnSubagentsEnabled(
  cfg: ShoggothConfig,
  logicalAgentId: string | undefined,
): boolean {
  if (logicalAgentId) {
    const per = cfg.agents?.list?.[logicalAgentId]?.spawnSubagents;
    if (typeof per === "boolean") return per;
  }
  if (typeof cfg.spawnSubagents === "boolean") return cfg.spawnSubagents;
  return true;
}
