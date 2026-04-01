import type { ShoggothConfig } from "@shoggoth/shared";
import { assertValidAgentId, parseAgentSessionUrn } from "@shoggoth/shared";
import {
  resolveDefaultSessionPlatform,
} from "../config/effective-runtime";
import { resolveBootstrapPrimarySessionUrn, resolveEffectivePlatformRoutesJson } from "@shoggoth/messaging";

/**
 * CLI/session tooling: if `raw` is a valid agent session URN, use it; otherwise treat `raw` as an
 * agent id and resolve the bootstrap **main** session URN (same rules as daemon bootstrap /
 * `resolveBootstrapPrimarySessionUrn`).
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
  const platform = resolveDefaultSessionPlatform(cfg);
  if (!platform) {
    throw new Error("no default session platform configured (set runtime.defaultSessionPlatform in config)");
  }
  const primaryChannelId = process.env.SHOGGOTH_PRIMARY_CHANNEL_ID?.trim();
  const routesJson = resolveEffectivePlatformRoutesJson(platform, cfg);
  return resolveBootstrapPrimarySessionUrn(t, platform, { primaryChannelId, routesJson });
}
