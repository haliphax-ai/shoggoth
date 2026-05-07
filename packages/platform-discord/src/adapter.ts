import { createInboundMessage, type MessageAttachment } from "@shoggoth/messaging";

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
  /** From Gateway `author.bot` (false when omitted in payload). */
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly timestampIso: string;
  readonly attachments?: readonly DiscordInboundAttachment[];
  readonly referencedMessageId?: string;
  readonly threadId?: string;
}

/** Gateway `MESSAGE_REACTION_ADD` (unicode or custom emoji). */
export interface DiscordReactionAddEvent {
  readonly kind: "message_reaction_add";
  readonly userId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly guildId?: string;
  readonly emoji: { readonly id: string | null; readonly name: string | null };
}

export interface DiscordAdapterConfig {
  readonly routes: readonly DiscordSessionRoute[];
  /**
   * When set, inbound messages whose Gateway payload includes `threadId` (forum / thread channel)
   * can resolve to a dynamically registered subagent session before falling back to channel routes.
   */
  readonly resolveThreadSessionId?: (threadId: string) => string | undefined;
}

export interface DiscordAdapter {
  inboundToInternal(ev: DiscordInboundEvent): ReturnType<typeof createInboundMessage>;
}

/** Thrown when a message arrives in a thread with no bound subagent session. */
export class UnboundThreadError extends Error {
  readonly threadChannelId: string;
  constructor(threadChannelId: string) {
    super(`Discord adapter: unbound thread ${threadChannelId}`);
    this.threadChannelId = threadChannelId;
  }
}

function resolveSessionId(
  routes: readonly DiscordSessionRoute[],
  guildId: string | undefined,
  channelId: string,
  resolveThread: DiscordAdapterConfig["resolveThreadSessionId"],
  threadId: string | undefined,
): string {
  if (resolveThread) {
    const keys = [channelId.trim(), threadId?.trim()].filter((k): k is string => Boolean(k));
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const sid = resolveThread(key);
      if (sid) return sid;
    }
    // threadId present but no binding found — do not fall through to static routes
    if (threadId?.trim()) {
      throw new UnboundThreadError(threadId.trim());
    }
  }
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
  const resolveThread = config.resolveThreadSessionId;

  return {
    inboundToInternal(ev: DiscordInboundEvent) {
      const sessionId = resolveSessionId(
        routes,
        ev.guildId,
        ev.channelId,
        resolveThread,
        ev.threadId,
      );
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
