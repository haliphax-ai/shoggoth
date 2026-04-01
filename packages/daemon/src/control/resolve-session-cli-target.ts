import type { ShoggothConfig } from "@shoggoth/shared";
import { assertValidAgentId, parseAgentSessionUrn, resolveAgentDefaultPlatform } from "@shoggoth/shared";
import { resolveBootstrapPrimarySessionUrn } from "@shoggoth/messaging";

/**
 * CLI/session tooling: if `raw` is a valid agent session URN, use it; otherwise treat `raw` as an
 * agent id and resolve the bootstrap **main** session URN (same rules as daemon bootstrap /
 * `resolveBootstrapPrimarySessionUrn`).
 *
 * Platform is derived from the target agent's platform bindings in `agents.list.<agentId>.platforms`.
 */
export function resolveSessionTargetFromCliArg(raw: string, cfg: ShoggothConfig): string {
  const t = raw.trim();
  if (!t) {
    throw new Error("session or agent id must be non-empty");
  }
  if (parseAgentSessionUrn(t)) {
    return t;
  }
  try {
    assertValidAgentId(t);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `not a valid session URN or agent id (${msg}); expected agent:<agentId>:<platform>:… or an agent id matching /^[a-zA-Z0-9._-]+$/`,
    );
  }
  const platform = resolveAgentDefaultPlatform(cfg, t);
  if (!platform) {
    throw new Error(
      `no platform bindings configured for agent "${t}" (add platforms under agents.list.${t}.platforms)`,
    );
  }
  const primaryChannelId = process.env.SHOGGOTH_PRIMARY_CHANNEL_ID?.trim();
  return resolveBootstrapPrimarySessionUrn(t, platform, { primaryChannelId });
}
