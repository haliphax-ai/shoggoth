import type { MessagingAdapterCapabilities } from "./capabilities";
import type { InternalMessage } from "./model";
import type { DiscordCreateMessageBody, DiscordRestTransport } from "./discord/transport";

export interface OutboundSenderConfig {
  readonly capabilities: MessagingAdapterCapabilities;
  readonly transport: DiscordRestTransport;
  readonly sessionToChannel: (sessionId: string) => string | undefined;
}

export interface SentMessageRef {
  readonly channelId: string;
  readonly messageId: string;
}

export interface OutboundSender {
  sendDiscord(msg: InternalMessage): Promise<SentMessageRef>;
}

function assertExtensionsAllowed(
  caps: MessagingAdapterCapabilities,
  msg: InternalMessage,
): void {
  const x = msg.extensions;
  if (x.attachments?.length && !caps.extensions.attachments) {
    throw new Error("Outbound: attachments not supported by this adapter capability set");
  }
  if (x.threadId && !caps.extensions.threads) {
    throw new Error("Outbound: threads not supported by this adapter capability set");
  }
  if (x.replyToMessageId && !caps.extensions.replies) {
    throw new Error("Outbound: replies not supported by this adapter capability set");
  }
}

function toDiscordBody(msg: InternalMessage): DiscordCreateMessageBody {
  if (msg.extensions.replyToMessageId) {
    return {
      content: msg.body,
      message_reference: { message_id: msg.extensions.replyToMessageId },
    };
  }
  return { content: msg.body };
}

export function createOutboundSender(config: OutboundSenderConfig): OutboundSender {
  const { capabilities, transport, sessionToChannel } = config;

  return {
    async sendDiscord(msg: InternalMessage): Promise<SentMessageRef> {
      assertExtensionsAllowed(capabilities, msg);
      const channelId = sessionToChannel(msg.sessionId);
      if (!channelId) {
        throw new Error(`Outbound: no Discord channel mapped for session ${msg.sessionId}`);
      }
      const res = await transport.createMessage(channelId, toDiscordBody(msg));
      return { channelId, messageId: res.id };
    },
  };
}
