import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";
import type { DiscordRestTransport } from "./transport";
import { splitDiscordMessage } from "./split-message";
import { mdTableToAscii } from "./table-formatter.js";
import { formatMessageWithThinking, type ThinkingDisplayMode } from "./thinking-formatter";

const DEFAULT_DISCORD_MAX_CONTENT = 2000;

export interface DiscordStreamingOutboundConfig {
  readonly transport: DiscordRestTransport;
  readonly capabilities: MessagingAdapterCapabilities;
  readonly channelId: string;
  readonly maxContentLength?: number;
  readonly thinkingDisplay?: ThinkingDisplayMode;
}

interface OverflowMessage {
  messageId: string;
  content: string;
}

export interface DiscordStreamHandle {
  readonly messageId: string;
  setFullContent(text: string): Promise<void>;
  pushUpdate(text: string): Promise<void>;
}

export interface DiscordStreamingOutbound {
  start(): Promise<DiscordStreamHandle>;
}

export function createDiscordStreamingOutbound(
  config: DiscordStreamingOutboundConfig,
): DiscordStreamingOutbound {
  const {
    transport,
    capabilities,
    channelId,
    maxContentLength = DEFAULT_DISCORD_MAX_CONTENT,
    thinkingDisplay,
  } = config;

  if (!capabilities.extensions.streamingOutbound) {
    return {
      async start() {
        throw new Error("Streaming outbound not supported for this adapter capability set");
      },
    };
  }

  return {
    async start(): Promise<DiscordStreamHandle> {
      const created = await transport.createMessage(channelId, {
        content: "…",
      });
      const messageId = created.id;
      const overflowMessages = new Map<number, OverflowMessage>();

      const reconcileOverflow = async (chunks: string[]): Promise<void> => {
        // Edit original message with first chunk
        await transport.editMessage(channelId, messageId, { content: chunks[0] });

        // Process remaining chunks
        for (let i = 1; i < chunks.length; i++) {
          const existing = overflowMessages.get(i);
          if (existing) {
            // Edit existing overflow message
            if (existing.content !== chunks[i]) {
              await transport.editMessage(channelId, existing.messageId, {
                content: chunks[i],
              });
              overflowMessages.set(i, { messageId: existing.messageId, content: chunks[i] });
            }
          } else {
            // Create new overflow message
            const created = await transport.createMessage(channelId, { content: chunks[i] });
            overflowMessages.set(i, { messageId: created.id, content: chunks[i] });
          }
        }

        // Delete any overflow messages beyond the current chunks
        const keysToDelete: number[] = [];
        for (const [index, _] of overflowMessages) {
          if (index >= chunks.length) {
            keysToDelete.push(index);
          }
        }
        for (const index of keysToDelete) {
          const overflow = overflowMessages.get(index);
          if (overflow) {
            await transport.deleteMessage(channelId, overflow.messageId);
            overflowMessages.delete(index);
          }
        }
      };

      return {
        messageId,
        async setFullContent(text: string): Promise<void> {
          let formattedText = text;
          if (thinkingDisplay) {
            formattedText = formatMessageWithThinking(text, thinkingDisplay);
          }
          formattedText = mdTableToAscii(formattedText);

          const chunks = splitDiscordMessage(formattedText, maxContentLength);
          await reconcileOverflow(chunks);
        },
        async pushUpdate(text: string): Promise<void> {
          let formattedText = text;
          if (thinkingDisplay) {
            formattedText = formatMessageWithThinking(text, thinkingDisplay);
          }
          formattedText = mdTableToAscii(formattedText);

          if (formattedText.length <= maxContentLength) {
            // Simple case: update original message only
            await transport.editMessage(channelId, messageId, { content: formattedText });
            // Delete all overflow messages
            for (const [_index, overflow] of overflowMessages) {
              await transport.deleteMessage(channelId, overflow.messageId);
            }
            overflowMessages.clear();
          } else {
            const chunks = splitDiscordMessage(formattedText, maxContentLength);
            await reconcileOverflow(chunks);
          }
        },
      };
    },
  };
}
