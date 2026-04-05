import type { MessagingAdapterCapabilities } from "./capabilities";

export interface CreateMessageBody {
  readonly content: string;
  readonly message_reference?: { readonly message_id: string };
  readonly allowed_mentions?: { readonly parse: readonly string[] };
}

export interface EditMessageBody {
  readonly content: string;
}

export interface MessageUploadFile {
  readonly filename: string;
  readonly data: Uint8Array;
}

export interface ChannelMessagesQuery {
  readonly limit?: number;
  readonly before?: string;
  readonly after?: string;
  readonly around?: string;
}

export interface SearchQuery {
  readonly content?: string;
  readonly author_id?: string | readonly string[];
  readonly channel_id?: string | readonly string[];
  readonly min_id?: string;
  readonly max_id?: string;
  readonly limit?: number;
}

export interface MessageToolTransport {
  createMessage(channelId: string, body: CreateMessageBody): Promise<{ readonly id: string }>;
  createMessageWithFiles(channelId: string, body: CreateMessageBody, files: readonly MessageUploadFile[]): Promise<{ readonly id: string }>;
  editMessage(channelId: string, messageId: string, body: EditMessageBody): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  getMessage(channelId: string, messageId: string): Promise<Record<string, unknown>>;
  getChannelMessages(channelId: string, query: ChannelMessagesQuery): Promise<readonly Record<string, unknown>[]>;
  createThreadFromMessage(channelId: string, messageId: string, body: { readonly name: string; readonly auto_archive_duration?: 60 | 1440 | 4320 | 10080 }): Promise<{ readonly id: string }>;
  deleteChannel(channelId: string): Promise<void>;
  createMessageReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  deleteMessageReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  getMessageReactions(channelId: string, messageId: string, emoji: string): Promise<readonly Record<string, unknown>[]>;
  searchMessages(guildId: string, query: SearchQuery): Promise<{ readonly messages: readonly Record<string, unknown>[][]; readonly total_results: number }>;
}
