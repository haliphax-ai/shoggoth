import type {
  McpServerRules,
  ShoggothConfig,
  ShoggothMemoryConfig,
  ShoggothModelsConfig,
  ThinkingDisplay,
} from "./schema.js";
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

/**
 * Effective allowed agent ids for `session.query`: merges global `sessionQuery.allowedAgentIds`
 * with `agents.list.<agentId>.sessionQuery.allowedAgentIds`, always including the caller's own id.
 */
export function resolveEffectiveSessionQueryAllowedAgentIds(
  cfg: ShoggothConfig,
  callerAgentId: string,
): Set<string> {
  const allowed = new Set<string>([callerAgentId]);
  const globalIds = cfg.sessionQuery?.allowedAgentIds;
  if (globalIds) for (const id of globalIds) allowed.add(id);
  const entry = findAgentEntry(cfg, callerAgentId);
  const perIds = entry?.sessionQuery?.allowedAgentIds;
  if (perIds) for (const id of perIds) allowed.add(id);
  return allowed;
}

function mergeDefaultInvocation(
  base: ShoggothModelsConfig["defaultInvocation"] | undefined,
  over: ShoggothModelsConfig["defaultInvocation"] | undefined,
): ShoggothModelsConfig["defaultInvocation"] | undefined {
  if (!over) return base;
  if (!base) return over;
  return { ...base, ...over };
}

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
      preserveRecentMessages:
        o!.compaction.preserveRecentMessages ??
        g?.preserveRecentMessages ??
        DEFAULT_COMPACTION_PRESERVE,
      summaryMaxOutputTokens: o!.compaction.summaryMaxOutputTokens ?? g?.summaryMaxOutputTokens,
      model: o!.compaction.model ?? g?.model,
    };
  }

  return {
    ...global,
    ...(chain && chain.length > 0
      ? {
          failoverChain: chain as unknown as ShoggothModelsConfig["failoverChain"],
        }
      : {}),
    ...(defaultInvocation !== undefined ? { defaultInvocation } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
  };
}

/** Default `emoji` in {@link formatAgentIdentityPrefix} when `agents.list.<id>.emoji` is unset. */
export const SHOGGOTH_AGENT_DEFAULT_EMOJI = "🦑";

/**
 * When `agents.list.<agentId>` exists for the session's logical agent id, returns a markdown header
 * to prepend before assistant text: `**<emoji> <label>:**` plus newline. `label` is `displayName` when set,
 * otherwise the agent id. `emoji` defaults to {@link SHOGGOTH_AGENT_DEFAULT_EMOJI} when omitted.
 * No prefix when there is no matching `agents.list` entry or the session URN has no agent id.
 */
export function formatAgentIdentityPrefix(cfg: ShoggothConfig, sessionId: string): string {
  const aid = resolveAgentIdFromSessionId(sessionId);
  if (!aid) return "";
  const idKey = aid.trim();
  const entry = cfg.agents?.list?.[idKey];
  const name = entry?.displayName?.trim() || idKey;
  const emoji = entry?.emoji?.trim() || SHOGGOTH_AGENT_DEFAULT_EMOJI;
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

/**
 * Effective thinkingDisplay setting for a session: per-agent `agents.list.<agentId>.thinkingDisplay`
 * takes precedence. Defaults to "none" when not configured.
 */
export function resolveEffectiveThinkingDisplay(
  cfg: ShoggothConfig,
  sessionId: string,
): ThinkingDisplay {
  const aid = resolveAgentIdFromSessionId(sessionId);
  if (aid) {
    const entry = findAgentEntry(cfg, aid);
    if (entry?.thinkingDisplay) {
      return entry.thinkingDisplay;
    }
  }
  return "none";
}

// ---------------------------------------------------------------------------
// MCP server allow/deny rules
// ---------------------------------------------------------------------------

const DEFAULT_MCP_SERVER_RULES: McpServerRules = { allow: ["*"], deny: [] };

/**
 * Evaluate whether a server id is allowed by the given rules.
 * Deny wins, then allow check, then default-deny.
 */
export function evaluateMcpServerRules(serverId: string, rules: McpServerRules): boolean {
  // 1. Deny wins
  if (rules.deny.includes(serverId) || rules.deny.includes("*")) return false;
  // 2. Allow check
  if (rules.allow.includes(serverId) || rules.allow.includes("*")) return true;
  // 3. Default-deny
  return false;
}

/**
 * Resolve effective MCP server rules via 4-level merge cascade.
 * Per-field replace: if the narrower scope provides `allow`, it replaces inherited `allow`; same for `deny`.
 */
export function resolveEffectiveMcpServerRules(
  config: ShoggothConfig,
  agentId: string,
  isSubagent: boolean,
): McpServerRules {
  // Hoist agent entry lookup — used by both subagent and top-level branches
  const entry = findAgentEntry(config, agentId);

  // Start with global rules
  let effective: McpServerRules = config.mcp?.serverRules
    ? { ...DEFAULT_MCP_SERVER_RULES, ...config.mcp.serverRules }
    : { ...DEFAULT_MCP_SERVER_RULES };

  if (isSubagent) {
    // Merge global subagent rules
    const globalSubagent = config.agents?.subagentMcp?.serverRules;
    if (globalSubagent) {
      effective = {
        allow: globalSubagent.allow !== undefined ? globalSubagent.allow : effective.allow,
        deny: globalSubagent.deny !== undefined ? globalSubagent.deny : effective.deny,
      };
    }
    // Merge per-agent subagent rules
    const perAgentSubagent = entry?.subagentMcp?.serverRules;
    if (perAgentSubagent) {
      effective = {
        allow: perAgentSubagent.allow !== undefined ? perAgentSubagent.allow : effective.allow,
        deny: perAgentSubagent.deny !== undefined ? perAgentSubagent.deny : effective.deny,
      };
    }
  } else {
    // Merge per-agent rules for top-level session
    const perAgent = entry?.mcp?.serverRules;
    if (perAgent) {
      effective = {
        allow: perAgent.allow !== undefined ? perAgent.allow : effective.allow,
        deny: perAgent.deny !== undefined ? perAgent.deny : effective.deny,
      };
    }
  }

  return effective;
}
