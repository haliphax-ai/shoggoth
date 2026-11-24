import { registerDiscordHitlNoticeAndAddReactions } from "./reaction-wiring";
import { NotFoundError } from "../rest-client";
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
        void sendDmNotice(
          input,
          resolveDmChannelId,
          (staleChannelId) => {
            if (dmChannelIdCached === staleChannelId) dmChannelIdCached = undefined;
          },
          content,
          row,
        ).catch((e) => {
          input.logger.warn("hitl.discord_dm_notify_failed", {
            err: String(e),
          });
        });
      }
    },
  };
}

/**
 * Deliver one HITL notice to the configured DM channel. On 404 from a
 * cached channel id (the user deleted the DM), the cache is dropped and the
 * channel is re-resolved once — but the retry is not re-attempted after a
 * second 404, so a genuinely broken DM target still surfaces the error.
 */
async function sendDmNotice(
  input: {
    readonly logger: Logger;
    readonly discord: DiscordMessagingRuntime;
    readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
  },
  resolveDmChannelId: () => Promise<string>,
  clearDmChannelCache: (channelId: string) => void,
  content: string,
  row: PendingActionRow,
): Promise<{ readonly id: string }> {
  const transport = input.discord.discordRestTransport;
  const ch = await resolveDmChannelId();
  try {
    return await sendToChannel(ch);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    input.logger.info("hitl.discord_dm_channel_gone", { channelId: ch });
    clearDmChannelCache(ch);
    const fresh = await resolveDmChannelId();
    try {
      return await sendToChannel(fresh);
    } catch (e2) {
      // The re-resolved channel is broken too — drop it so the next notice
      // re-resolves instead of pinning the failure into the cache.
      clearDmChannelCache(fresh);
      throw e2;
    }
  }

  async function sendToChannel(channelId: string): Promise<{ readonly id: string }> {
    const sent = await transport.createMessage(channelId, { content });
    if (input.hitlDiscordNoticeRegistry) {
      await registerDiscordHitlNoticeAndAddReactions({
        transport,
        channelId,
        messageId: sent.id,
        row,
        registry: input.hitlDiscordNoticeRegistry,
        logger: input.logger,
      });
    }
    return sent;
  }
}
