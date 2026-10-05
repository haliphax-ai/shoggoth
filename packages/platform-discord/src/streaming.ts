import type { MessagingAdapterCapabilities } from "@shoggoth/messaging";
import type { DiscordBridgeLogger } from "./bridge";
import type { DiscordRestTransport } from "./transport";
import { splitDiscordMessage } from "./split-message";
import { mdTableToAscii } from "./table-formatter.js";
import { formatMessageWithThinking, type ThinkingDisplayMode } from "./thinking-formatter";

const DEFAULT_DISCORD_MAX_CONTENT = 2000;
/** Total attempts (first try + retries) for deleting a single overflow message. */
const DELETE_MAX_ATTEMPTS = 3;
/** Exponential backoff base between delete attempts (250ms, 500ms; total added delay ≤ 750ms). */
const DELETE_RETRY_BASE_DELAY_MS = 250;

export interface DiscordStreamingOutboundConfig {
  readonly transport: DiscordRestTransport;
  readonly capabilities: MessagingAdapterCapabilities;
  readonly channelId: string;
  readonly maxContentLength?: number;
  readonly thinkingDisplay?: ThinkingDisplayMode;
  /** Optional logger; used to report overflow deletions abandoned after exhausting retries. */
  readonly logger?: DiscordBridgeLogger;
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
    logger,
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

      /**
       * Deletes a single overflow message, retrying transient failures with
       * exponential backoff up to a finite limit. Never throws: after
       * exhausting retries the message is abandoned (logged at warn).
       * Returns true when the deletion succeeded.
       */
      const deleteOverflowWithRetry = async (messageId: string): Promise<boolean> => {
        for (let attempt = 1; attempt <= DELETE_MAX_ATTEMPTS; attempt++) {
          try {
            await transport.deleteMessage(channelId, messageId);
            return true;
          } catch (err) {
            if (attempt < DELETE_MAX_ATTEMPTS) {
              await new Promise((resolve) =>
                setTimeout(resolve, DELETE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)),
              );
            } else {
              logger?.warn("discord.streaming.overflow_delete_failed", {
                messageId,
                attempts: DELETE_MAX_ATTEMPTS,
                err: String(err),
              });
            }
          }
        }
        return false;
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
            // Delete all overflow messages. Each deletion is retried with
            // backoff a finite number of times; a failure on one message must
            // never abort cleanup of the remaining ones. Entries that still
            // fail after the final attempt are dropped (already logged).
            for (const [index, overflow] of overflowMessages) {
              // Success removes the message; give-up (already logged inside
              // the helper) drops the entry so it is not retried forever.
              await deleteOverflowWithRetry(overflow.messageId);
              overflowMessages.delete(index);
            }
          } else {
            const chunks = splitDiscordMessage(formattedText, maxContentLength);
            await reconcileOverflow(chunks);
          }
        },
      };
    },
  };
}
