import type { ShoggothConfig, ShoggothMemoryConfig, ShoggothModelsConfig } from "./schema.js";
import { parseAgentSessionUrn } from "./session-urn.js";

function findAgentEntry(cfg: ShoggothConfig, agentId: string) {
  const map = cfg.agents?.list;
  if (!map) return undefined;
  const k = agentId.trim();
  return map[k];
}

/** Logical agent id from `agent:<agentId>:…` session URN, or undefined when not parseable. */
export function resolveAgentIdFromSessionId(sessionId: string): string | undefined {
  return parseAgentSessionUrn(sessionId)?.agentId;
}

function mergeDefaultInvocation(
  base: ShoggothModelsConfig["defaultInvocation"] | undefined,
  over: ShoggothModelsConfig["defaultInvocation"] | undefined,
): ShoggothModelsConfig["defaultInvocation"] | undefined {
  if (!over) return base;
  if (!base) return over;
  return { ...base, ...over };
}

const DEFAULT_COMPACTION_MAX = 80_000;
const DEFAULT_COMPACTION_PRESERVE = 8;

function agentModelsHasOverrides(
  o:
    | {
        primary?: unknown;
        failoverChain?: readonly unknown[];
        defaultInvocation?: unknown;
        compaction?: Record<string, unknown>;
      }
    | undefined,
): boolean {
  if (!o) return false;
  if (o.primary != null) return true;
  if (o.failoverChain != null && o.failoverChain.length > 0) return true;
  if (o.defaultInvocation != null) return true;
  if (o.compaction != null && Object.keys(o.compaction).length > 0) return true;
  return false;
}

/**
 * Effective `models` for a session: merges `agents.list.<agentId>` (when the key matches the session URN)
 * over global `config.models`. Session-stored `model_selection` is still merged later by
 * {@link mergeModelInvocationParams} in the daemon.
 */
export function resolveEffectiveModelsConfig(
  cfg: ShoggothConfig,
  sessionId: string,
): ShoggothModelsConfig | undefined {
  const global = cfg.models;
  const aid = resolveAgentIdFromSessionId(sessionId);
  if (!aid) return global;
  const entry = findAgentEntry(cfg, aid);
  const o = entry?.models;
  if (!agentModelsHasOverrides(o)) return global;

  const chain =
    o!.failoverChain && o!.failoverChain.length > 0
      ? o!.failoverChain
      : o!.primary
        ? [o!.primary]
        : undefined;

  const defaultInvocation = mergeDefaultInvocation(global?.defaultInvocation, o!.defaultInvocation);

  let compaction = global?.compaction;
  if (o!.compaction != null && Object.keys(o!.compaction).length > 0) {
    const g = global?.compaction;
    compaction = {
      maxContextChars: o!.compaction.maxContextChars ?? g?.maxContextChars ?? DEFAULT_COMPACTION_MAX,
      preserveRecentMessages:
        o!.compaction.preserveRecentMessages ?? g?.preserveRecentMessages ?? DEFAULT_COMPACTION_PRESERVE,
      summaryMaxOutputTokens: o!.compaction.summaryMaxOutputTokens ?? g?.summaryMaxOutputTokens,
    };
  }

  return {
    ...(global ?? {}),
    ...(chain && chain.length > 0 ? { failoverChain: chain } : {}),
    ...(defaultInvocation !== undefined ? { defaultInvocation } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
  };
}

/** Default `emoji` in {@link formatDiscordAgentIdentityPrefix} when `agents.list.<id>.emoji` is unset. */
export const SHOGGOTH_DISCORD_AGENT_DEFAULT_EMOJI = "🦑";

/**
 * When `agents.list.<agentId>` exists for the session's logical agent id, returns a Discord markdown header
 * to prepend before assistant text: `**<emoji> <label>:**` plus newline. `label` is `displayName` when set,
 * otherwise the agent id. `emoji` defaults to {@link SHOGGOTH_DISCORD_AGENT_DEFAULT_EMOJI} when omitted.
 * No prefix when there is no matching `agents.list` entry or the session URN has no agent id.
 */
export function formatDiscordAgentIdentityPrefix(cfg: ShoggothConfig, sessionId: string): string {
  const aid = resolveAgentIdFromSessionId(sessionId);
  if (!aid) return "";
  const idKey = aid.trim();
  const entry = cfg.agents?.list?.[idKey];
  const name = entry?.displayName?.trim() || idKey;
  const emoji = entry?.emoji?.trim() || SHOGGOTH_DISCORD_AGENT_DEFAULT_EMOJI;
  return `**${emoji} ${name}:**\n`;
}

/**
 * Effective memory roots for a session: global `memory.paths` plus `agents.list.<agentId>.memory.paths` for
 * the session's logical agent id (deduped).
 */
export function resolveEffectiveMemoryForSession(
  cfg: ShoggothConfig,
  sessionId: string,
): ShoggothMemoryConfig {
  const base = cfg.memory;
  const aid = resolveAgentIdFromSessionId(sessionId);
  const entry = aid ? findAgentEntry(cfg, aid) : undefined;
  const extra = entry?.memory?.paths;
  if (!extra?.length) return base;
  const seen = new Set(base.paths);
  const merged = [...base.paths];
  for (const p of extra) {
    if (seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
  }
  return { ...base, paths: merged };
}
