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

export interface DiscordRestTransport {
  /** POST `/users/@me/channels` — returns the DM channel id for `createMessage`. */
  openDmChannel(recipientUserId: string): Promise<string>;
  createMessage(
    channelId: string,
    body: DiscordCreateMessageBody,
  ): Promise<{ readonly id: string }>;
  editMessage(channelId: string, messageId: string, body: DiscordEditMessageBody): Promise<void>;
}
