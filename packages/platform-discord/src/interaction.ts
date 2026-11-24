/**
 * Discord INTERACTION_CREATE event parsing — maps slash command interactions
 * to platform-agnostic {@link PlatformCommand} via the daemon command interface.
 */

import type { PlatformCommand } from "@shoggoth/daemon/lib";

/** Discord interaction types we care about. */
export const APPLICATION_COMMAND = 2;
export const MESSAGE_COMPONENT = 3;
export const MODAL_SUBMIT = 5;
/** Interaction response type 4 = CHANNEL_MESSAGE_WITH_SOURCE. */
export const INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
/** Interaction response type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE. */
export const INTERACTION_RESPONSE_DEFERRED = 5;
export const INTERACTION_RESPONSE_UPDATE_MESSAGE = 7;
export const INTERACTION_RESPONSE_MODAL = 9;

export interface DiscordInteractionEvent {
  readonly kind: "interaction_create";
  readonly id: string;
  readonly token: string;
  /** Discord interaction type (2 = APPLICATION_COMMAND, 3 = MESSAGE_COMPONENT, 5 = MODAL_SUBMIT). */
  readonly type: number;
  readonly channelId: string;
  readonly guildId?: string;
  readonly userId: string;
  readonly data: {
    readonly name?: string;
    readonly options?: ReadonlyArray<{
      readonly name: string;
      readonly type: number;
      readonly value: unknown;
    }>;
    readonly custom_id?: string;
    readonly values?: readonly string[];
    readonly component_type?: number;
    readonly components?: ReadonlyArray<{
      readonly type: number;
      readonly components: ReadonlyArray<{
        readonly type: number;
        readonly custom_id: string;
        readonly value: string;
      }>;
    }>;
    readonly message?: {
      readonly id: string;
      readonly content?: string;
    };
  };
}

export interface DiscordParsedInteraction {
  readonly command: PlatformCommand;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly channelId: string;
  readonly guildId?: string;
}

/** Parse a Discord interaction event into a PlatformCommand. Returns null for non-slash-command interactions. */
export function discordInteractionToCommand(
  ev: DiscordInteractionEvent,
): DiscordParsedInteraction | null {
  if (ev.type !== APPLICATION_COMMAND) return null;
  const name = ev.data?.name;
  if (typeof name !== "string" || !name.trim()) return null;

  const options: Record<string, string> = {};
  if (ev.data.options) {
    for (const opt of ev.data.options) {
      if (typeof opt.value === "string") {
        options[opt.name] = opt.value;
      } else if (opt.value !== undefined && opt.value !== null) {
        options[opt.name] = String(opt.value);
      }
    }
  }

  return {
    command: { name: name.trim(), options },
    interactionId: ev.id,
    interactionToken: ev.token,
    channelId: ev.channelId,
    guildId: ev.guildId,
  };
}
