/**
 * Discord INTERACTION_CREATE event parsing — maps slash command interactions
 * to platform-agnostic {@link PlatformCommand} via the daemon command interface.
 */

import type { PlatformCommand } from "@shoggoth/daemon/lib";

/** Discord interaction types we care about. */
const APPLICATION_COMMAND = 2;

export interface DiscordInteractionEvent {
  readonly kind: "interaction_create";
  readonly id: string;
  readonly token: string;
  /** Discord interaction type (2 = APPLICATION_COMMAND). */
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
