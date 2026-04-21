// ---------------------------------------------------------------------------
// Discord Platform Plugin — implements MessagingPlatformPlugin
// See: plans/2026-04-20_hooks-plugin-overhaul/spec.md §6
// ---------------------------------------------------------------------------

import {
  defineMessagingPlatformPlugin,
  type MessagingPlatformPlugin,
} from "@shoggoth/plugins";
import { discordPlatformRegistration } from "./platform-registration";
import { createDiscordProbe } from "./probe";
import type { DiscordMessagingRuntime } from "./bootstrap";
import type { DiscordReactionAddEvent } from "./hitl/reaction-handler";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import type { DiscordPlatformHandle } from "./platform";

/** State held across the plugin's lifecycle. */
interface DiscordPluginState {
  messaging?: DiscordMessagingRuntime;
  platform?: DiscordPlatformHandle;
  hitlNoticeRegistry?: HitlDiscordNoticeRegistry;
  reactionBotUserIdRef: { current: string | undefined };
  reactionPassthroughRef: { current: ((ev: DiscordReactionAddEvent) => void) | undefined };
}

export function createDiscordPlugin(): MessagingPlatformPlugin {
  const state: DiscordPluginState = {
    reactionBotUserIdRef: { current: undefined },
    reactionPassthroughRef: { current: undefined },
  };

  return defineMessagingPlatformPlugin({
    name: "platform-discord",
    hooks: {
      "platform.register"(ctx) {
        ctx.registerPlatform(discordPlatformRegistration);
      },

      async "platform.start"(_ctx) {
        // The full Discord wiring (gateway startup, interaction handler,
        // HITL reactions, reaction passthrough, subagent extension,
        // message tool context, platform adapter, persistent subagent
        // reconciliation) is orchestrated here when the daemon fires
        // the hook with real PlatformStartCtx dependencies.
        //
        // Currently the daemon still performs this wiring inline during
        // its boot sequence. As the migration progresses, the logic
        // moves here and the daemon becomes fully platform-agnostic.
      },

      async "platform.stop"(_ctx) {
        if (state.platform) {
          await state.platform.stop();
          state.platform = undefined;
        }
        if (state.messaging) {
          await state.messaging.stop();
          state.messaging = undefined;
        }
        state.hitlNoticeRegistry = undefined;
        state.reactionPassthroughRef.current = undefined;
      },

      "health.register"(ctx) {
        ctx.registerProbe(
          createDiscordProbe({
            getToken: () => undefined,
          }),
        );
      },
    },
  });
}
