import { registerDiscordHitlNoticeAndAddReactions } from "./reaction-wiring";
import {
  formatHitlPayloadExcerpt,
  buildHitlQueuedNoticeLines,
  HITL_NOTICE_PAYLOAD_MAX_CHARS,
} from "@shoggoth/daemon/lib";
import type { HitlNotifier, PendingActionRow, Logger } from "../daemon-types";
import type { HitlDiscordNoticeRegistry } from "./notice-registry";
import type { DiscordMessagingRuntime } from "../bridge";

// Re-export presentation-layer symbols so existing consumers (index.ts, tests) keep working.
export { formatHitlPayloadExcerpt, buildHitlQueuedNoticeLines, HITL_NOTICE_PAYLOAD_MAX_CHARS };

export function createDiscordHitlNotifier(input: {
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly discord: DiscordMessagingRuntime;
  /** When set, REST-posted notices get reaction "buttons" and registry entries for owner approval. */
  readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
}): HitlNotifier {
  const hitlNotifyChannelId = input.env.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID?.trim();
  const hitlNotifyWebhookUrl = input.env.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL?.trim();
  const hitlNotifyDmUserId = input.env.SHOGGOTH_HITL_NOTIFY_DM_USER_ID?.trim();

  let dmChannelIdCached: string | undefined;
  let dmChannelInflight: Promise<string> | undefined;

  function resolveDmChannelId(): Promise<string> {
    if (dmChannelIdCached) return Promise.resolve(dmChannelIdCached);
    if (!hitlNotifyDmUserId) {
      return Promise.reject(new Error("SHOGGOTH_HITL_NOTIFY_DM_USER_ID unset"));
    }
    dmChannelInflight ??= input.discord.discordRestTransport
      .openDmChannel(hitlNotifyDmUserId)
      .then((id) => {
        dmChannelIdCached = id;
        dmChannelInflight = undefined;
        return id;
      })
      .catch((e) => {
        dmChannelInflight = undefined;
        throw e;
      });
    return dmChannelInflight;
  }

  return {
    onQueued(row: PendingActionRow): void {
      input.logger.info("hitl.pending_queued", {
        pendingId: row.id,
        sessionId: row.sessionId,
        tool: row.toolName,
        riskTier: row.riskTier,
        correlationId: row.correlationId,
        expiresAt: row.expiresAt,
      });
      if (hitlNotifyWebhookUrl) {
        const payloadPreview = formatHitlPayloadExcerpt(row.payload) ?? null;
        const body = JSON.stringify({
          event: "hitl.pending_queued",
          pendingId: row.id,
          sessionId: row.sessionId,
          tool: row.toolName,
          riskTier: row.riskTier,
          correlationId: row.correlationId ?? null,
          expiresAt: row.expiresAt,
          payloadPreview,
        });
        void fetch(hitlNotifyWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }).catch((e) => {
          input.logger.warn("hitl.webhook_notify_failed", { err: String(e) });
        });
      }
      const lines = buildHitlQueuedNoticeLines(row);
      const content = lines.join("\n");
      if (hitlNotifyChannelId) {
        void input.discord.discordRestTransport
          .createMessage(hitlNotifyChannelId, { content })
          .then(async (sent) => {
            if (!input.hitlDiscordNoticeRegistry) return;
            await registerDiscordHitlNoticeAndAddReactions({
              transport: input.discord.discordRestTransport,
              channelId: hitlNotifyChannelId,
              messageId: sent.id,
              row,
              registry: input.hitlDiscordNoticeRegistry,
              logger: input.logger,
            });
          })
          .catch((e) => {
            input.logger.warn("hitl.discord_notify_failed", { err: String(e) });
          });
      }
      if (hitlNotifyDmUserId) {
        void resolveDmChannelId()
          .then(async (ch) => {
            const sent = await input.discord.discordRestTransport.createMessage(ch, { content });
            if (!input.hitlDiscordNoticeRegistry) return;
            await registerDiscordHitlNoticeAndAddReactions({
              transport: input.discord.discordRestTransport,
              channelId: ch,
              messageId: sent.id,
              row,
              registry: input.hitlDiscordNoticeRegistry,
              logger: input.logger,
            });
          })
          .catch((e) => {
            input.logger.warn("hitl.discord_dm_notify_failed", { err: String(e) });
          });
      }
    },
  };
}
