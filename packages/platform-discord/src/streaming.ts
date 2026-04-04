import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";
import type { DiscordRestTransport } from "./transport";
import { splitDiscordMessage } from "./split-message";
import { formatMessageWithThinking, type ThinkingDisplayMode } from "./thinking-formatter";

const DEFAULT_DISCORD_MAX_CONTENT = 2000;

export interface DiscordStreamingOutboundConfig {
  readonly transport: DiscordRestTransport;
  readonly capabilities: MessagingAdapterCapabilities;
  readonly channelId: string;
  readonly maxContentLength?: number;
  readonly thinkingDisplay?: ThinkingDisplayMode;
}

export interface DiscordStreamHandle {
  readonly messageId: string;
  setFullContent(text: string): Promise<void>;
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
      const created = await transport.createMessage(channelId, { content: "…" });
      const messageId = created.id;

      return {
        messageId,
        async setFullContent(text: string): Promise<void> {
          // Apply thinking display formatting if configured
          let formattedText = text;
          if (thinkingDisplay) {
            formattedText = formatMessageWithThinking(text, thinkingDisplay);
          }

          const chunks = splitDiscordMessage(formattedText, maxContentLength);
          // Edit the original streaming message with the first chunk.
          await transport.editMessage(channelId, messageId, { content: chunks[0] });
          // Send remaining chunks as new messages.
          for (let i = 1; i < chunks.length; i++) {
            await transport.createMessage(channelId, { content: chunks[i] });
          }
        },
      };
    },
  };
}
