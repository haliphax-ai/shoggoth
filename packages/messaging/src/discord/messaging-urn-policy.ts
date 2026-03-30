import {
  formatAgentSessionUrn,
  parseAgentSessionUrn,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  SHOGGOTH_SESSION_UUID_RE,
  type ParsedAgentSessionUrn,
} from "@shoggoth/shared";

/** Thrown when messaging routes JSON is structurally valid but violates this transport's URN rules. */
export class DiscordRoutesConfigurationError extends Error {
  override readonly name = "DiscordRoutesConfigurationError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Discord snowflake (channel, user, guild, …) as a decimal string.
 * Discord-specific — not used by core session URN parsing.
 */
export const DISCORD_SNOWFLAKE_RE = /^\d{17,22}$/;

export function isDiscordSessionUrnTailSegment(seg: string): boolean {
  const s = seg.trim();
  return SHOGGOTH_SESSION_UUID_RE.test(s) || DISCORD_SNOWFLAKE_RE.test(s);
}

export type DiscordRouteSessionUrnCheck = "ok" | "drop" | { readonly fatal: string };

/**
 * Validates the session tail for a Discord messaging route: each segment must be a UUID or snowflake;
 * single-leaf snowflake sessions must match `channelId` when it is also a snowflake.
 */
export function checkDiscordMessagingRouteSessionUrn(
  parsed: ParsedAgentSessionUrn,
  channelId: string,
): DiscordRouteSessionUrnCheck {
  if (parsed.platform.toLowerCase() !== "discord") return "drop";
  for (const seg of parsed.uuidChain) {
    if (!isDiscordSessionUrnTailSegment(seg)) return "drop";
  }
  if (parsed.uuidChain.length === 1) {
    const leaf = parsed.uuidChain[0]!;
    const ch = channelId.trim();
    if (DISCORD_SNOWFLAKE_RE.test(leaf) && DISCORD_SNOWFLAKE_RE.test(ch) && leaf !== ch) {
      return {
        fatal:
          `discord route: sessionId leaf ${JSON.stringify(leaf)} must equal channelId ${JSON.stringify(ch)} when both are Discord snowflakes`,
      };
    }
  }
  return "ok";
}

const DEFAULT_PRIMARY_UUID_LOWER = SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID.toLowerCase();

export type DiscordDefaultPrimaryMultiAgentGuard = {
  /** Declared agents (from `agents.list`); when non-empty, default-primary UUID routes are validated per entry. */
  readonly agentsList?: ReadonlyArray<{ readonly id: string; readonly defaultSessionPlatform?: string }>;
};

/**
 * Ensures any route whose session URN uses the reserved default-primary UUID is consistent with
 * the configured process agent / platform, or with `agents.list` map keys when multi-agent guard is passed.
 */
export function assertDiscordRoutesDefaultPrimaryUuidMatchesAgent(
  routes: ReadonlyArray<{ readonly sessionId: string }>,
  resolvedAgentId: string,
  resolvedPlatform: string,
  multiAgent?: DiscordDefaultPrimaryMultiAgentGuard,
): void {
  const aid0 = resolvedAgentId.trim();
  const plat0 = resolvedPlatform.trim();
  const list = multiAgent?.agentsList ?? [];

  if (!list.length) {
    const expected = formatAgentSessionUrn(aid0, plat0, SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    for (let i = 0; i < routes.length; i++) {
      const p = parseAgentSessionUrn(routes[i]!.sessionId);
      if (!p) continue;
      if (p.uuidChain.length !== 1) continue;
      if (p.uuidChain[0] !== DEFAULT_PRIMARY_UUID_LOWER) continue;
      if (p.agentId === aid0 && p.platform === plat0) continue;
      throw new Error(
        `discord route[${i}] sessionId uses reserved primary UUID (${SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID}) but ` +
          `agent:platform ${JSON.stringify(p.agentId)}:${JSON.stringify(p.platform)} do not match ` +
          `SHOGGOTH_AGENT_ID / SHOGGOTH_DEFAULT_SESSION_PLATFORM (${JSON.stringify(aid0)}:${JSON.stringify(plat0)}). ` +
          `Expected ${JSON.stringify(expected)} or use a different session leaf in the URN.`,
      );
    }
    return;
  }

  for (let i = 0; i < routes.length; i++) {
    const p = parseAgentSessionUrn(routes[i]!.sessionId);
    if (!p) continue;
    if (p.uuidChain.length !== 1) continue;
    if (p.uuidChain[0] !== DEFAULT_PRIMARY_UUID_LOWER) continue;

    const entry = list.find((a) => a.id === p.agentId);
    const platformForAgent = entry?.defaultSessionPlatform?.trim() || plat0;
    if (entry) {
      if (p.platform !== platformForAgent) {
        throw new Error(
          `discord route[${i}] sessionId uses reserved primary UUID but platform ${JSON.stringify(p.platform)} ` +
            `does not match expected ${JSON.stringify(platformForAgent)} for agent ${JSON.stringify(p.agentId)}`,
        );
      }
      continue;
    }

    if (p.agentId === aid0 && p.platform === plat0) continue;
    throw new Error(
      `discord route[${i}] sessionId uses reserved primary UUID for agent ${JSON.stringify(p.agentId)} which is not listed in agents.list ` +
        `(add it as a key under agents.list, or align the URN with SHOGGOTH_AGENT_ID / SHOGGOTH_DEFAULT_SESSION_PLATFORM ${JSON.stringify(aid0)}:${JSON.stringify(plat0)})`,
    );
  }
}

/** First `channelId` in a routes JSON array (bootstrap helper; shape is transport-defined). */
export function parseFirstDiscordChannelIdFromRoutesJson(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  try {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const ch = (arr[0] as { channelId?: string })?.channelId?.trim?.();
    return ch || undefined;
  } catch {
    return undefined;
  }
}

export interface DiscordBootstrapPrimaryOptions {
  readonly primaryChannelId?: string | undefined;
  readonly routesJson?: string | undefined;
}

/**
 * Primary SQLite session id for bootstrap: Discord uses a channel snowflake in the URN when
 * `SHOGGOTH_PRIMARY_DISCORD_CHANNEL_ID` or the first routes entry `channelId` is a valid snowflake;
 * otherwise the shared reserved primary UUID.
 */
export function resolveDiscordBootstrapPrimarySessionUrn(
  agentId: string,
  platform: string,
  options?: DiscordBootstrapPrimaryOptions,
): string {
  const ch =
    options?.primaryChannelId?.trim() || parseFirstDiscordChannelIdFromRoutesJson(options?.routesJson);
  if (ch && DISCORD_SNOWFLAKE_RE.test(ch)) {
    return formatAgentSessionUrn(agentId, platform, ch);
  }
  return formatAgentSessionUrn(agentId, platform, SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
}
