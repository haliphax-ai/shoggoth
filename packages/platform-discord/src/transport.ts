/**
 * Injectable Discord REST surface for tests and daemon wiring.
 */

export interface DiscordCreateMessageBody {
  readonly content: string;
  readonly message_reference?: { readonly message_id: string };
  readonly allowed_mentions?: { readonly parse: readonly string[] };
}

export interface DiscordEditMessageBody {
  readonly content: string;
}

/** Multipart file part for {@link DiscordRestTransport.createMessageWithFiles}. */
export interface DiscordMessageUploadFile {
  readonly filename: string;
  readonly data: Uint8Array;
}

/** Query for GET `/channels/{id}/messages` (at most one of before / after / around). */
export interface DiscordChannelMessagesQuery {
  readonly limit?: number;
  readonly before?: string;
  readonly after?: string;
  readonly around?: string;
}

/** Query for GET `/guilds/{id}/messages/search`. */
export interface DiscordSearchQuery {
  readonly content?: string;
  readonly author_id?: string | readonly string[];
  readonly channel_id?: string | readonly string[];
  readonly min_id?: string;
  readonly max_id?: string;
  readonly limit?: number;
}

export interface DiscordRestTransport {
  /** POST `/users/@me/channels` — returns the DM channel id for `createMessage`. */
  openDmChannel(recipientUserId: string): Promise<string>;
  createMessage(
    channelId: string,
    body: DiscordCreateMessageBody,
  ): Promise<{ readonly id: string }>;
  /**
   * POST `/channels/{id}/messages` with `multipart/form-data` (`payload_json` + `files[n]`).
   * Use when sending attachments; JSON-only {@link createMessage} otherwise.
   */
  createMessageWithFiles(
    channelId: string,
    body: DiscordCreateMessageBody,
    files: readonly DiscordMessageUploadFile[],
  ): Promise<{ readonly id: string }>;
  editMessage(channelId: string, messageId: string, body: DiscordEditMessageBody): Promise<void>;
  /** DELETE `/channels/{channel.id}/messages/{message.id}` */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /**
   * POST `/channels/{channel.id}/messages/{message.id}/threads` — returns the new thread channel id.
   */
  createThreadFromMessage(
    channelId: string,
    messageId: string,
    body: { readonly name: string; readonly auto_archive_duration?: 60 | 1440 | 4320 | 10080 },
  ): Promise<{ readonly id: string }>;
  /** DELETE `/channels/{channel.id}` — also deletes thread channels. */
  deleteChannel(channelId: string): Promise<void>;
  /** GET `/channels/{channel.id}/messages/{message.id}` — returns raw API message object. */
  getMessage(channelId: string, messageId: string): Promise<Record<string, unknown>>;
  /** GET `/channels/{channel.id}/messages` — returns newest-first array per Discord API. */
  getChannelMessages(channelId: string, query: DiscordChannelMessagesQuery): Promise<readonly Record<string, unknown>[]>;
  /**
   * PUT `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me` — unicode `emoji` is
   * passed raw and URL-encoded (e.g. `✅`). Custom emojis use `name:id`.
   */
  createMessageReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * DELETE `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me` — remove the bot's
   * own reaction. Unicode `emoji` is URL-encoded; custom emojis use `name:id`.
   */
  deleteMessageReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * GET `/channels/{channel.id}/messages/{message.id}/reactions/{emoji}` — returns users who
   * reacted with this emoji. When `emoji` is omitted by the caller, the message-tool layer
   * fetches the full message and aggregates from its `reactions` array.
   */
  getMessageReactions(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<readonly Record<string, unknown>[]>;
  /**
   * GET `/guilds/{guild.id}/messages/search` or channel-scoped search.
   * Discord search supports `content`, `author_id`, `channel_id`, `min_id`, `max_id`, etc.
   */
  searchMessages(
    guildId: string,
    query: DiscordSearchQuery,
  ): Promise<{ readonly messages: readonly Record<string, unknown>[][]; readonly total_results: number }>;
  /** POST `/channels/{channel.id}/typing` — lasts ~10s; renew for long model turns. */
  triggerTypingIndicator(channelId: string): Promise<void>;
  /** POST `/interactions/{id}/{token}/callback` — respond to a slash command interaction. */
  interactionCallback(
    interactionId: string,
    interactionToken: string,
    body: { readonly type: number; readonly data?: { readonly content: string } },
  ): Promise<void>;
  /** PUT `/applications/{appId}/commands` — register global slash commands. */
  registerGlobalCommands(
    applicationId: string,
    commands: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void>;
  /** PATCH `/webhooks/{appId}/{token}/messages/@original` — edit a deferred interaction response. */
  editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    body: { readonly content: string },
  ): Promise<void>;
}
