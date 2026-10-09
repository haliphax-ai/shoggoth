import type { ShoggothConfig } from "./schema.js";

/** Default maximum subagent nesting depth: top-level sessions may spawn; subagents may not. */
export const DEFAULT_MAX_SPAWN_DEPTH = 1;

/** Safety cap on lineage walks; longer chains are treated as unresolvable (deny). */
const MAX_LINEAGE_WALK = 64;

/**
 * Effective `maxSpawnDepth` for an agent id. Per-agent
 * `agents.list.<id>.maxSpawnDepth` overrides top-level `maxSpawnDepth` when set;
 * omitted or invalid values fall back to {@link DEFAULT_MAX_SPAWN_DEPTH} (1 — the
 * historical behavior: only top-level sessions may spawn).
 *
 * Depth of a top-level session is 0; a session at depth `d` may spawn a subagent
 * iff `d < maxDepth`. With `maxSpawnDepth: 1` a subagent at depth 1 may not spawn;
 * with `2` it may spawn a depth-2 subagent which then may not spawn, and so on.
 * `0` disables subagent spawning entirely.
 *
 * This is purely an *additional* nesting gate that applies to sessions already
 * permitted to spawn by `spawnSubagents` / `subagentSpawnAllow` — it does not
 * replace or modify those gates. It also governs session-level subagent nesting
 * only, not the workflow engine's separate `maxDepth`.
 */
export function effectiveMaxSpawnDepth(
  cfg: ShoggothConfig,
  logicalAgentId: string | undefined,
): number {
  if (logicalAgentId) {
    const per = cfg.agents?.list?.[logicalAgentId]?.maxSpawnDepth;
    if (typeof per === "number" && Number.isInteger(per) && per >= 0) return per;
  }
  if (
    typeof cfg.maxSpawnDepth === "number" &&
    Number.isInteger(cfg.maxSpawnDepth) &&
    cfg.maxSpawnDepth >= 0
  ) {
    return cfg.maxSpawnDepth;
  }
  return DEFAULT_MAX_SPAWN_DEPTH;
}

/**
 * Depth of `sessionId` in the session lineage, by walking parent links: a
 * top-level session is depth 0, each nested subagent level adds 1.
 *
 * `lookupParent` returns the parent session id for a given session (`null` when
 * the session has no parent) or `undefined` when the session cannot be resolved.
 * Returns `-1` when the lineage cannot be fully resolved — missing row, cycle,
 * or a chain beyond the safety cap — so callers degrade to the most restrictive
 * outcome (deny).
 */
export function computeSessionDepth(
  lookupParent: (sessionId: string) => string | null | undefined,
  sessionId: string,
): number {
  let depth = 0;
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = lookupParent(current);
    if (parent === undefined) return -1;
    if (parent === null) return depth;
    if (seen.has(parent) || depth >= MAX_LINEAGE_WALK) return -1;
    seen.add(parent);
    current = parent;
    depth += 1;
  }
}

/**
 * May a session at `currentDepth` spawn a subagent under `maxDepth`? An
 * unresolvable depth (`-1`) is always denied.
 */
export function maySpawnSubagentAtDepth(currentDepth: number, maxDepth: number): boolean {
  return Number.isInteger(currentDepth) && currentDepth >= 0 && currentDepth < maxDepth;
}
