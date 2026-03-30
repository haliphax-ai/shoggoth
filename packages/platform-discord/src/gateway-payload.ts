import type {
  DiscordInboundAttachment,
  DiscordInboundEvent,
  DiscordReactionAddEvent,
} from "./adapter";
import type { DiscordInteractionEvent } from "./interaction";

/**
 * Default gateway intents: GUILDS + GUILD_MESSAGES + GUILD_MESSAGE_REACTIONS + DIRECT_MESSAGES +
 * DIRECT_MESSAGE_REACTIONS + MESSAGE_CONTENT_INTENT.
 * Guild text requires the privileged Message Content Intent in the Discord developer portal.
 */
export const DISCORD_GATEWAY_INTENTS_DEFAULT =
  (1 << 0) + (1 << 9) + (1 << 10) + (1 << 12) + (1 << 13) + (1 << 15);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Maps a Discord Gateway MESSAGE_CREATE `d` payload to our inbound event shape.
 */
export function discordMessageCreateToInboundEvent(
  d: unknown,
  options: { readonly allowBotMessages: boolean },
): DiscordInboundEvent | null {
  const o = asRecord(d);
  if (!o) return null;

  const author = asRecord(o.author);
  const authorId = author?.id;
  if (typeof authorId !== "string") return null;
  if (author?.bot === true && !options.allowBotMessages) return null;

  const messageId = o.id;
  const channelId = o.channel_id;
  if (typeof messageId !== "string" || typeof channelId !== "string") return null;

  const guildId = o.guild_id;
  const content = typeof o.content === "string" ? o.content : "";

  const ts = o.timestamp;
  const timestampIso = typeof ts === "string" ? ts : new Date().toISOString();

  const ref = asRecord(o.message_reference);
  const referencedMessageId =
    typeof ref?.message_id === "string" ? ref.message_id : undefined;

  const rawAtts = o.attachments;
  let attachments: readonly DiscordInboundAttachment[] | undefined;
  if (Array.isArray(rawAtts) && rawAtts.length > 0) {
    attachments = rawAtts
      .map((a): DiscordInboundAttachment | null => {
        const ar = asRecord(a);
        if (!ar) return null;
        const id = ar.id;
        const url = ar.url;
        const filename = ar.filename;
        if (typeof id !== "string" || typeof url !== "string" || typeof filename !== "string") {
          return null;
        }
        const contentType = typeof ar.content_type === "string" ? ar.content_type : undefined;
        const sizeBytes = typeof ar.size === "number" ? ar.size : undefined;
        return { id, url, filename, contentType, sizeBytes };
      })
      .filter((x): x is DiscordInboundAttachment => x !== null);
    if (attachments.length === 0) attachments = undefined;
  }

  return {
    kind: "message_create",
    messageId,
    channelId,
    guildId: typeof guildId === "string" ? guildId : undefined,
    authorId,
    authorIsBot: author?.bot === true,
    content,
    timestampIso,
    attachments,
    referencedMessageId,
  };
}

/**
 * Extract the bot's user snowflake from a Gateway `READY` `d` payload (`d.user.id`).
 */
export function discordReadyPayloadToBotUserId(d: unknown): string | undefined {
  const o = asRecord(d);
  if (!o) return undefined;
  const user = asRecord(o.user);
  const id = user?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Maps Discord Gateway `MESSAGE_REACTION_ADD` `d` payload to our event shape.
 */
export function discordMessageReactionAddToEvent(d: unknown): DiscordReactionAddEvent | null {
  const o = asRecord(d);
  if (!o) return null;
  const userId = o.user_id;
  const channelId = o.channel_id;
  const messageId = o.message_id;
  if (typeof userId !== "string" || typeof channelId !== "string" || typeof messageId !== "string") {
    return null;
  }
  const guildId = o.guild_id;
  const em = asRecord(o.emoji);
  if (!em) return null;
  const id = em.id;
  const name = em.name;
  return {
    kind: "message_reaction_add",
    userId,
    channelId,
    messageId,
    guildId: typeof guildId === "string" ? guildId : undefined,
    emoji: {
      id: typeof id === "string" ? id : null,
      name: typeof name === "string" ? name : null,
    },
  };
}

/**
 * Maps a Discord Gateway `INTERACTION_CREATE` `d` payload to our interaction event shape.
 * Returns null for payloads missing required fields.
 */
export function discordInteractionCreateToEvent(d: unknown): DiscordInteractionEvent | null {
  const o = asRecord(d);
  if (!o) return null;

  const id = o.id;
  const token = o.token;
  const type = o.type;
  const channelId = o.channel_id;
  if (
    typeof id !== "string" ||
    typeof token !== "string" ||
    typeof type !== "number" ||
    typeof channelId !== "string"
  ) {
    return null;
  }

  const guildId = o.guild_id;

  // User id lives in `member.user.id` (guild) or `user.id` (DM).
  const member = asRecord(o.member);
  const memberUser = member ? asRecord(member.user) : null;
  const topUser = asRecord(o.user);
  const userId = memberUser?.id ?? topUser?.id;
  if (typeof userId !== "string") return null;

  const rawData = asRecord(o.data);
  const data: DiscordInteractionEvent["data"] = {
    name: typeof rawData?.name === "string" ? rawData.name : undefined,
    options: Array.isArray(rawData?.options)
      ? (rawData.options as Array<{ name: string; type: number; value: unknown }>)
      : undefined,
  };

  return {
    kind: "interaction_create",
    id,
    token,
    type,
    channelId,
    guildId: typeof guildId === "string" ? guildId : undefined,
    userId,
    data,
  };
}
