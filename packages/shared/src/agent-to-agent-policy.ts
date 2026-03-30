import type { ShoggothConfig } from "./schema.js";

function resolveAgentsListToAgentAllow(
  cfg: ShoggothConfig["agents"],
  senderAgentId: string,
): string[] | undefined {
  const map = cfg?.list;
  if (!map || Object.keys(map).length === 0) {
    return undefined;
  }
  const entry = map[senderAgentId.trim()];
  if (!entry) return undefined;
  const allow = entry.agentToAgent?.allow;
  return Array.isArray(allow) ? allow : undefined;
}

/**
 * Merges top-level `agentToAgent.allow` with `agents.list.<senderId>.agentToAgent.allow` for the matching
 * sender id (deduped). Used for cross-agent `session_send` target checks; same-agent sends are
 * always allowed by {@link crossAgentSessionSendAllowed}.
 */
export function mergeAgentToAgentAllowPatterns(
  cfg: Pick<ShoggothConfig, "agentToAgent" | "agents">,
  senderAgentId: string,
): string[] {
  const globalAllow = cfg.agentToAgent?.allow ?? [];
  const per = resolveAgentsListToAgentAllow(cfg.agents, senderAgentId);
  const merged = [...globalAllow, ...(per ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of merged) {
    const t = String(x).trim();
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Whether an **agent** principal may `session_send` to a session whose URN carries `targetAgentId`.
 * Operators are not checked here. When `agentToAgent` / `agents` omit allow data, only same-agent targets are allowed.
 */
export function crossAgentSessionSendAllowed(
  cfg: Pick<ShoggothConfig, "agentToAgent" | "agents">,
  senderAgentId: string,
  targetAgentId: string,
): boolean {
  if (senderAgentId === targetAgentId) {
    return true;
  }
  const patterns = mergeAgentToAgentAllowPatterns(cfg, senderAgentId);
  if (patterns.length === 0) {
    return false;
  }
  for (const p of patterns) {
    if (p === "*") {
      return true;
    }
    if (p === targetAgentId) {
      return true;
    }
  }
  return false;
}
