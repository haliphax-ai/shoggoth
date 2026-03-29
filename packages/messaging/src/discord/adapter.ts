import { createInboundMessage, type MessageAttachment } from "../model";

export interface DiscordSessionRoute {
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionId: string;
}

export interface DiscordInboundAttachment {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
}

export interface DiscordInboundEvent {
  readonly kind: "message_create";
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly authorId: string;
  readonly content: string;
  readonly timestampIso: string;
  readonly attachments?: readonly DiscordInboundAttachment[];
  readonly referencedMessageId?: string;
  readonly threadId?: string;
}

export interface DiscordAdapterConfig {
  readonly routes: readonly DiscordSessionRoute[];
}

export interface DiscordAdapter {
  inboundToInternal(ev: DiscordInboundEvent): ReturnType<typeof createInboundMessage>;
}

function resolveSessionId(
  routes: readonly DiscordSessionRoute[],
  guildId: string | undefined,
  channelId: string,
): string {
  for (const r of routes) {
    if (r.channelId !== channelId) continue;
    if (r.guildId !== undefined && r.guildId !== guildId) continue;
    if (r.guildId === undefined && guildId !== undefined) continue;
    return r.sessionId;
  }
  throw new Error(
    `Discord adapter: no session route for channel ${channelId}` +
      (guildId !== undefined ? ` guild ${guildId}` : " (DM)"),
  );
}

export function createDiscordAdapter(config: DiscordAdapterConfig): DiscordAdapter {
  const routes = config.routes;

  return {
    inboundToInternal(ev: DiscordInboundEvent) {
      const sessionId = resolveSessionId(routes, ev.guildId, ev.channelId);
      const attachments: MessageAttachment[] | undefined = ev.attachments?.map((a) => ({
        id: a.id,
        url: a.url,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      }));
      return createInboundMessage({
        id: ev.messageId,
        sessionId,
        userId: `discord:${ev.authorId}`,
        createdAt: ev.timestampIso,
        body: ev.content,
        extensions: {
          attachments,
          threadId: ev.threadId,
          replyToMessageId: ev.referencedMessageId,
        },
      });
    },
  };
}
