import type { ContextLevel, ShoggothConfig } from "./schema";
import { contextLevelSchema } from "./schema";

/**
 * Resolve the effective context level for a session.
 *
 * Precedence (highest first): explicit spawn override, then per-agent config
 * (`agents.list[agentId].subagentContextLevel` / `.contextLevel`), then
 * top-level config (`agents.subagentContextLevel` / `agents.contextLevel`),
 * then defaults (`"full"` top-level, `"light"` subagents). Full details:
 * docs/shared.md — "Context Levels".
 */
export function resolveContextLevel(
  config: ShoggothConfig,
  agentId: string,
  spawnOverride?: ContextLevel,
  isSubagent?: boolean,
): ContextLevel {
  if (spawnOverride != null) return spawnOverride;

  const agentEntry = config.agents?.list?.[agentId];
  const field = isSubagent ? "subagentContextLevel" : "contextLevel";

  const perAgent = agentEntry?.[field];
  if (perAgent != null) return perAgent;

  const topLevel = config.agents?.[field];
  if (topLevel != null) return topLevel;

  return isSubagent ? "light" : "full";
}

/**
 * Validate that a string is a valid context level. Returns the typed value or throws.
 */
export function validateContextLevel(value: unknown): ContextLevel {
  return contextLevelSchema.parse(value);
}
