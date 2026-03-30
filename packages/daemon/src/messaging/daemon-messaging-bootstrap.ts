import {
  startDiscordMessagingIfConfigured,
  type DiscordMessagingRuntime,
  type DiscordReactionAddEvent,
} from "@shoggoth/messaging";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { Logger } from "../logging";
import {
  resolveDiscordAllowBotMessages,
  resolveDiscordIntents,
  resolveDiscordOwnerUserId,
  resolveDefaultSessionPlatform,
  resolveEffectiveDiscordRoutesJson,
  resolveShoggothAgentId,
} from "../config/effective-runtime";

export type { DiscordMessagingRuntime };

export interface StartDaemonDiscordMessagingOptions {
  readonly logger: Logger;
  readonly config: ShoggothConfig;
  /** Resolved token (`DISCORD_BOT_TOKEN` env wins over layered `discord.botToken`). */
  readonly botToken: string | undefined;
  readonly onMessageReactionAdd?: (ev: DiscordReactionAddEvent) => void;
  readonly reactionBotUserIdRef?: { current: string | undefined };
}

/**
 * Starts Discord messaging (gateway + routes + A2A bus) when enabled in config and credentials exist.
 * URN policies must already be registered ({@link registerBuiltInMessagingPlatforms}).
 */
export async function startDaemonDiscordMessaging(
  opts: StartDaemonDiscordMessagingOptions,
): Promise<DiscordMessagingRuntime | undefined> {
  if (opts.config.discord?.enabled === false) {
    return undefined;
  }
  return startDiscordMessagingIfConfigured({
    logger: opts.logger,
    botToken: opts.botToken,
    routesJson: resolveEffectiveDiscordRoutesJson(opts.config),
    intents: resolveDiscordIntents(opts.config),
    allowBotMessages: resolveDiscordAllowBotMessages(opts.config),
    ownerUserId: resolveDiscordOwnerUserId(opts.config),
    routeGuard: {
      resolvedAgentId: resolveShoggothAgentId(opts.config),
      defaultSessionPlatform: resolveDefaultSessionPlatform(opts.config),
      agentsList: opts.config.agents?.list
        ? Object.entries(opts.config.agents.list).map(([id, a]) => ({
            id: id.trim(),
            ...(a.defaultSessionPlatform ? { defaultSessionPlatform: a.defaultSessionPlatform } : {}),
          }))
        : undefined,
    },
    onMessageReactionAdd: opts.onMessageReactionAdd,
    reactionBotUserIdRef: opts.reactionBotUserIdRef,
  });
}
