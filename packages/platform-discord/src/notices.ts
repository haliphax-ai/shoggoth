/**
 * Notice resolution helper for platform-discord.
 *
 * The daemon's notice resolver is injected through `DiscordPlatformOptions`
 * at platform construction; this module hosts the shared delegate used by
 * platform-discord call sites.
 */
import type { NoticeResolver } from "./daemon-types";

/** Resolve a notice template through the injected daemon resolver. */
export function notice(
  resolve: NoticeResolver,
  key: string,
  vars: Record<string, string> = {},
): string {
  return resolve(key, vars);
}
