/**
 * Discord implementation of the presentation-layer PlatformAdapter interface.
 *
 * This adapter owns transport concerns only: message splitting, outbound delivery,
 * streaming placeholders, typing indicators, and reaction transport.
 * Formatting and orchestration are handled by the presentation layer.
 */

import { randomUUID } from "node:crypto";
import { createOutboundMessage, MESSAGING_FEATURE, messagingCapabilitiesHasFeature } from "@shoggoth/messaging";
import type {
  PlatformAdapter,
  PlatformCapabilities,
  StreamHandle,
  HitlNoticeData,
} from "@shoggoth/daemon/lib";
import type { DiscordMessagingRuntime } from "./bridge";
import type { DiscordRestTransport } from "./transport";
import { DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS, sliceDiscordPlatformMessageBody } from "./errors";
import { splitDiscordMessage } from "./split-message";
import type { HitlDiscordNoticeRegistry } from "./hitl/notice-registry";
import { registerDiscordHitlNoticeAndAddReactions } from "./hitl/reaction-wiring";
import type { Logger, PendingActionRow } from "./daemon-types";

/** Discord typing indicator lasts ~10s; renew while the model formulates a reply. */
const DISCORD_TYPING_RENEWAL_MS = 8000;

export interface DiscordPlatformAdapterConfig {
  readonly discord: DiscordMessagingRuntime;
  readonly logger: Logger;
  readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;
}

export class DiscordPlatformAdapter implements PlatformAdapter {
  readonly maxBodyLength = DISCORD_PLATFORM_MAX_MESSAGE_BODY_CHARS;
  readonly capabilities: PlatformCapabilities;

  private readonly discord: DiscordMessagingRuntime;
  private readonly logger: Logger;
  private readonly hitlDiscordNoticeRegistry?: HitlDiscordNoticeRegistry;

  constructor(config: DiscordPlatformAdapterConfig) {
    this.discord = config.discord;
    this.logger = config.logger;
    this.hitlDiscordNoticeRegistry = config.hitlDiscordNoticeRegistry;

    const transport = config.discord.discordRestTransport;
    this.capabilities = buildDiscordCapabilities(config.discord, transport);
  }

  async sendBody(sessionId: string, body: string, opts?: { replyTo?: string }): Promise<void> {
    const chunks = splitDiscordMessage(body);
    for (let i = 0; i < chunks.length; i++) {
      await this.discord.outbound.sendDiscord(
        createOutboundMessage({
          id: randomUUID(),
          sessionId,
          userId: "system",
          createdAt: new Date().toISOString(),
          body: chunks[i],
          extensions: i === 0 && opts?.replyTo ? { replyToMessageId: opts.replyTo } : {},
        }),
      );
    }
  }

  async sendError(sessionId: string, body: string, opts?: { replyTo?: string }): Promise<void> {
    try {
      await this.discord.outbound.sendDiscord(
        createOutboundMessage({
          id: randomUUID(),
          sessionId,
          userId: "system",
          createdAt: new Date().toISOString(),
          body: sliceDiscordPlatformMessageBody(body),
          extensions: opts?.replyTo ? { replyToMessageId: opts.replyTo } : {},
        }),
      );
    } catch (sendErr) {
      this.logger.error("discord.adapter.error_reply_failed", { err: String(sendErr) });
    }
  }

  async startStream(sessionId: string, opts?: { replyTo?: string }): Promise<StreamHandle> {
    const streamingOutbound = this.discord.streamingForSession(sessionId);
    if (!streamingOutbound) {
      throw new Error("Streaming not available for this session");
    }
    const handle = await streamingOutbound.start();
    return {
      setFullContent: (text: string) => handle.setFullContent(text),
    };
  }

  async sendHitlNotice(
    sessionId: string,
    notice: HitlNoticeData,
  ): Promise<{ channelId: string; messageId: string } | void> {
    const content = sliceDiscordPlatformMessageBody(notice.lines.join("\n"));
    const ref = await this.discord.outbound.sendDiscord(
      createOutboundMessage({
        id: randomUUID(),
        sessionId,
        userId: "system",
        createdAt: new Date().toISOString(),
        body: content,
        extensions: {},
      }),
    );
    if (this.hitlDiscordNoticeRegistry) {
      const row: PendingActionRow = {
        id: notice.pendingId,
        sessionId: notice.sessionId,
        correlationId: undefined,
        toolName: notice.toolName,
        resourceSummary: undefined,
        payload: undefined,
        riskTier: notice.riskTier as PendingActionRow["riskTier"],
        status: "pending",
        denialReason: undefined,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      await registerDiscordHitlNoticeAndAddReactions({
        transport: this.discord.discordRestTransport,
        channelId: ref.channelId,
        messageId: ref.messageId,
        row,
        registry: this.hitlDiscordNoticeRegistry,
        logger: this.logger,
      });
    }
    return { channelId: ref.channelId, messageId: ref.messageId };
  }

  /**
   * Run work wrapped in a typing indicator that auto-renews.
   */
  async withTypingIndicator(sessionId: string, work: () => Promise<void>): Promise<void> {
    if (!messagingCapabilitiesHasFeature(this.discord.capabilities, MESSAGING_FEATURE.TYPING_NOTIFICATION)) {
      await work();
      return;
    }
    await this.discord.notifyAgentTypingForSession(sessionId);
    const id = setInterval(() => {
      void this.discord.notifyAgentTypingForSession(sessionId);
    }, DISCORD_TYPING_RENEWAL_MS);
    try {
      await work();
    } finally {
      clearInterval(id);
    }
  }
}

function buildDiscordCapabilities(
  discord: DiscordMessagingRuntime,
  transport: DiscordRestTransport,
): PlatformCapabilities {
  return {
    reactions: {
      addReaction: (channelId: string, messageId: string, emoji: string) =>
        transport.createMessageReaction(channelId, messageId, emoji),
      removeReaction: (channelId: string, messageId: string, emoji: string) =>
        transport.deleteMessageReaction(channelId, messageId, emoji),
    },
    threads: true,
    embeds: true,
    typing: {
      start: (sessionId: string) => {
        void discord.notifyAgentTypingForSession(sessionId);
      },
      stop: (_sessionId: string) => {
        // Discord typing stops automatically when a message is sent.
      },
    },
  };
}
