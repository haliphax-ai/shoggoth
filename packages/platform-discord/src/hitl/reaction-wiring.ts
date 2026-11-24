import type { DiscordRestTransport } from "../transport";
import type { Logger, PendingActionRow } from "../daemon-types";
import type { HitlDiscordNoticeRegistry } from "./notice-registry";

/** Reaction "buttons" on HITL notices (owner-only; see discord-hitl-reaction-handler). */
export const HITL_DISCORD_NOTICE_REACTION_EMOJIS = ["1️⃣", "✅", "♾️", "❌"] as const;

export async function registerDiscordHitlNoticeAndAddReactions(input: {
  readonly transport: DiscordRestTransport;
  readonly channelId: string;
  readonly messageId: string;
  readonly row: PendingActionRow;
  readonly registry: HitlDiscordNoticeRegistry;
  readonly logger: Logger;
}): Promise<void> {
  input.registry.register(
    input.channelId,
    input.messageId,
    input.row.id,
    input.row.sessionId,
    input.row.toolName,
  );
  const settled = await Promise.allSettled(
    HITL_DISCORD_NOTICE_REACTION_EMOJIS.map((emoji) =>
      input.transport.createMessageReaction(input.channelId, input.messageId, emoji).then(
        () => emoji,
        (e: unknown) => Promise.reject({ emoji, cause: e }),
      ),
    ),
  );
  const failedEmojis: string[] = [];
  const errors: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      const { emoji, cause } = outcome.reason as { emoji: string; cause: unknown };
      failedEmojis.push(emoji);
      errors.push(cause);
    }
  }
  if (failedEmojis.length > 0) {
    input.logger.warn("hitl.discord_reactions_failed", {
      failedEmojis,
      err: errors.map(String).join("; "),
    });
  }
}
