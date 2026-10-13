import {
  startDiscordMessagingIfConfigured,
  type DiscordMessagingRuntime,
  type DiscordReactionAddEvent,
  type DiscordThreadCreateEvent,
} from "./bridge";
import type { DiscordInteractionEvent } from "./interaction";
import { isPlatformEnabled, type ShoggothConfig } from "@shoggoth/shared";
import type { DiscordBridgeLogger } from "./bridge";
import type { NoticeResolver } from "./daemon-types";
import { setNoticeResolver } from "./notices";
import {
  resolveDiscordAllowBotMessages,
  resolveDiscordCommandGuildIds,
  resolveDiscordIntents,
  resolveDiscordOwnerUserId,
  resolveEffectiveDiscordRoutes,
  resolveShoggothAgentId,
} from "./config";
import { registerDiscordSlashCommands, cleanupLegacyGlobalCommands } from "./slash-commands";

export type { DiscordMessagingRuntime };

export interface StartDaemonDiscordMessagingOptions {
  readonly logger: DiscordBridgeLogger;
  readonly config: ShoggothConfig;
  /**
   * Resolved token (`tokenEnv` env var — `DISCORD_BOT_TOKEN` by default — wins
   * over layered `discord.token`).
   */
  readonly botToken: string | undefined;
  readonly onMessageReactionAdd?: (ev: DiscordReactionAddEvent) => void;
  readonly onInteractionCreate?: (ev: DiscordInteractionEvent) => void;
  /** Gateway `THREAD_CREATE` — forwarded verbatim; the daemon core decides what to do. */
  readonly onThreadCreate?: (ev: DiscordThreadCreateEvent) => void;
  /**
   * Liveness probe for thread-binding rejection (see
   * `StartDiscordMessagingOptions.isSessionActive`).
   */
  readonly isSessionActive?: (sessionId: string) => boolean;
  readonly reactionBotUserIdRef?: { current: string | undefined };
  /** Daemon's notice resolver — wired into platform-discord's `setNoticeResolver` at startup. */
  readonly noticeResolver?: NoticeResolver;
  /** When true, register guild slash commands on startup (requires bot user id). */
  readonly registerSlashCommands?: boolean;
}

/**
 * Starts Discord messaging (gateway + routes + A2A bus) when enabled in config and credentials exist.
 * URN policies must already be registered via {@link registerPlatform}({@link discordPlatformRegistration}).
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
    onThreadCreate: opts.onThreadCreate,
    reactionBotUserIdRef: opts.reactionBotUserIdRef,
    isSessionActive: opts.isSessionActive,
  });

  if (runtime && opts.registerSlashCommands !== false && runtime.discordBotUserId) {
    // Slash commands are guild-scoped: explicit platforms.discord.commandGuildIds
    // wins, otherwise the unique guilds across routes.
    const guildIds = resolveDiscordCommandGuildIds(opts.config);
    if (guildIds.length === 0) {
      opts.logger.warn("discord.slash_commands.no_guilds", {
        reason: "no guild IDs in Discord routes; guild-scoped commands cannot be registered",
      });
    } else {
      try {
        await registerDiscordSlashCommands({
          transport: runtime.discordRestTransport,
          applicationId: runtime.discordBotUserId,
          guildIds,
        });
        opts.logger.info("discord.slash_commands.registered", {
          applicationId: runtime.discordBotUserId,
          guildIds,
        });
        // Migration: drop legacy globally-registered Shoggoth commands so they
        // don't linger as duplicates next to the guild-scoped ones. Failure is
        // non-fatal — guild registration already succeeded.
        try {
          await cleanupLegacyGlobalCommands({
            transport: runtime.discordRestTransport,
            applicationId: runtime.discordBotUserId,
          });
        } catch (e) {
          opts.logger.warn("discord.slash_commands.legacy_global_cleanup_failed", {
            err: String(e),
          });
        }
      } catch (e) {
        opts.logger.warn("discord.slash_commands.registration_failed", {
          err: String(e),
        });
      }
    }
  }

  return runtime;
}
