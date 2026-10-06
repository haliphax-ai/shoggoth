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
import { registerDiscordSlashCommands, deregisterDiscordSlashCommands } from "./slash-commands";
import type { DiscordRestTransport } from "./transport";

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
  readonly reactionBotUserIdRef?: { current: string | undefined };
  /** Daemon's notice resolver — wired into platform-discord's `setNoticeResolver` at startup. */
  readonly noticeResolver?: NoticeResolver;
  /** When true, register global slash commands on startup (requires bot user id). */
  readonly registerSlashCommands?: boolean;
  /**
   * Registration-state signal: set to the application ID when this instance successfully
   * registered the global slash commands, and cleared when they are de-registered. Lets
   * the shutdown drain de-register only what this instance registered.
   */
  readonly slashCommandRegistrationRef?: { current: string | undefined };
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
      if (opts.slashCommandRegistrationRef) {
        opts.slashCommandRegistrationRef.current = runtime.discordBotUserId;
      }
    } catch (e) {
      opts.logger.warn("discord.slash_commands.registration_failed", {
        err: String(e),
      });
    }
  }

  return runtime;
}

/**
 * Shutdown drain for Discord messaging: de-registers the global slash commands this
 * instance registered (if any) *before* stopping the transport, so the command list is
 * cleaned up while the REST client is still usable.
 *
 * De-registration is skipped unless this instance registered at startup (registration
 * was enabled and succeeded), and runs at most once per instance. Failures are logged
 * and swallowed so shutdown never hangs or crashes on a REST error, but the attempt is
 * awaited so the HTTP call completes before process exit.
 */
export function createDiscordMessagingShutdownDrain(opts: {
  readonly registrationRef: { current: string | undefined };
  readonly transport: DiscordRestTransport | undefined;
  readonly logger: {
    readonly info: (msg: string, fields?: Record<string, unknown>) => void;
    readonly warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
  readonly stop: () => void | Promise<void>;
}): () => Promise<void> {
  return async () => {
    const applicationId = opts.registrationRef.current;
    if (applicationId && opts.transport) {
      // Consume the registration state first so de-registration happens at most once.
      opts.registrationRef.current = undefined;
      try {
        await deregisterDiscordSlashCommands({
          transport: opts.transport,
          applicationId,
        });
        opts.logger.info("discord.slash_commands.deregistered", {
          applicationId,
        });
      } catch (e) {
        opts.logger.warn("discord.slash_commands.deregistration_failed", {
          err: String(e),
        });
      }
    }
    await opts.stop();
  };
}
