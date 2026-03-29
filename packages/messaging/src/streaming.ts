import type { MessagingAdapterCapabilities } from "./capabilities";
import type { DiscordRestTransport } from "./discord/transport";

const DEFAULT_DISCORD_MAX_CONTENT = 2000;

export interface DiscordStreamingOutboundConfig {
  readonly transport: DiscordRestTransport;
  readonly capabilities: MessagingAdapterCapabilities;
  readonly channelId: string;
  readonly maxContentLength?: number;
}

export interface DiscordStreamHandle {
  readonly messageId: string;
  setFullContent(text: string): Promise<void>;
}

export interface DiscordStreamingOutbound {
  start(): Promise<DiscordStreamHandle>;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function createDiscordStreamingOutbound(
  config: DiscordStreamingOutboundConfig,
): DiscordStreamingOutbound {
  const {
    transport,
    capabilities,
    channelId,
    maxContentLength = DEFAULT_DISCORD_MAX_CONTENT,
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
          const content = truncate(text, maxContentLength);
          await transport.editMessage(channelId, messageId, { content });
        },
      };
    },
  };
}
