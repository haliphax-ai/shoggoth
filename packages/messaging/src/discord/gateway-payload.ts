import type { DiscordInboundAttachment, DiscordInboundEvent } from "./adapter";

/**
 * Default gateway intents: GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT_INTENT.
 * Guild text requires the privileged Message Content Intent in the Discord developer portal.
 */
export const DISCORD_GATEWAY_INTENTS_DEFAULT =
  (1 << 0) + (1 << 9) + (1 << 12) + (1 << 15);

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
    content,
    timestampIso,
    attachments,
    referencedMessageId,
  };
}
