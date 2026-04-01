import {
  startDiscordMessagingIfConfigured,
  type DiscordMessagingRuntime,
  type DiscordReactionAddEvent,
} from "./bridge";
import type { DiscordInteractionEvent } from "./interaction";
import { isPlatformEnabled, type ShoggothConfig } from "@shoggoth/shared";
import type { DiscordBridgeLogger } from "./bridge";
import type { NoticeResolver } from "./daemon-types";
import { setNoticeResolver } from "./notices";
import {
  resolveDiscordAllowBotMessages,
  resolveDiscordIntents,
  resolveDiscordOwnerUserId,
  resolveEffectiveDiscordRoutes,
  resolveShoggothAgentId,
} from "./config";
import { registerDiscordSlashCommands } from "./slash-commands";

export type { DiscordMessagingRuntime };

export interface StartDaemonDiscordMessagingOptions {
  readonly logger: DiscordBridgeLogger;
  readonly config: ShoggothConfig;
  /** Resolved token (`DISCORD_BOT_TOKEN` env wins over layered `discord.token`). */
  readonly botToken: string | undefined;
  readonly onMessageReactionAdd?: (ev: DiscordReactionAddEvent) => void;
  readonly onInteractionCreate?: (ev: DiscordInteractionEvent) => void;
  readonly reactionBotUserIdRef?: { current: string | undefined };
  /** Daemon's notice resolver — wired into platform-discord's `setNoticeResolver` at startup. */
  readonly noticeResolver?: NoticeResolver;
  /** When true, register global slash commands on startup (requires bot user id). */
  readonly registerSlashCommands?: boolean;
}

/**
 * Starts Discord messaging (gateway + routes + A2A bus) when enabled in config and credentials exist.
 * URN policies must already be registered ({@link registerBuiltInMessagingPlatforms}).
 */
export async function startDaemonDiscordMessaging(
  opts: StartDaemonDiscordMessagingOptions,
): Promise<DiscordMessagingRuntime | undefined> {
  if (opts.noticeResolver) {
    setNoticeResolver(opts.noticeResolver);
  }
  if (!isPlatformEnabled(opts.config, "discord")) {
    return undefined;
  }
  const runtime = await startDiscordMessagingIfConfigured({
    logger: opts.logger,
    botToken: opts.botToken,
    routes: resolveEffectiveDiscordRoutes(opts.config),
    intents: resolveDiscordIntents(opts.config),
    allowBotMessages: resolveDiscordAllowBotMessages(opts.config),
    ownerUserId: resolveDiscordOwnerUserId(opts.config),
    routeGuard: {
      resolvedAgentId: resolveShoggothAgentId(opts.config),
      agentsList: opts.config.agents?.list
        ? Object.entries(opts.config.agents.list).map(([id]) => ({
            id: id.trim(),
          }))
        : undefined,
    },
    onMessageReactionAdd: opts.onMessageReactionAdd,
    onInteractionCreate: opts.onInteractionCreate,
    reactionBotUserIdRef: opts.reactionBotUserIdRef,
  });

  if (runtime && opts.registerSlashCommands !== false && runtime.discordBotUserId) {
    try {
      await registerDiscordSlashCommands({
        transport: runtime.discordRestTransport,
        applicationId: runtime.discordBotUserId,
      });
      opts.logger.info("discord.slash_commands.registered", {
        applicationId: runtime.discordBotUserId,
      });
    } catch (e) {
      opts.logger.warn("discord.slash_commands.registration_failed", { err: String(e) });
    }
  }

  return runtime;
}
