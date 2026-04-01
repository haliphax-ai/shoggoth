/**
 * Per-adapter capability negotiation.
 * Schemas are JSON-Schema-shaped records for client negotiation without extra deps.
 */

export interface JsonSchemaLike {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchemaLike>;
  readonly items?: JsonSchemaLike;
  readonly required?: readonly string[];
  readonly maxLength?: number;
  readonly maximum?: number;
}

export interface ExtensionFlags {
  readonly attachments: boolean;
  readonly threads: boolean;
  readonly replies: boolean;
  readonly reactionsInbound: boolean;
  readonly streamingOutbound: boolean;
  /** Agent `message` tool: PATCH existing messages (platform-specific). */
  readonly messageEdit: boolean;
  /** Agent `message` tool: delete messages. */
  readonly messageDelete: boolean;
  /** Agent `message` tool: start a thread from an existing message. */
  readonly threadCreate: boolean;
  /** Agent `message` tool: delete a thread channel. */
  readonly threadDelete: boolean;
  /** Agent `message` tool: read message(s) via platform API (e.g. platform GET message / channel messages). */
  readonly messageGet: boolean;
  /** Agent `message` tool: add/remove emoji reactions on messages. */
  readonly react: boolean;
  /** Agent `message` tool: read reactions on a message. */
  readonly reactions: boolean;
  /** Agent `message` tool: search/filter messages by keyword, author, time range. */
  readonly search: boolean;
  /** Agent `message` tool: download file attachments from messages. */
  readonly attachmentDownload: boolean;
}

/** Well-known {@link MessagingAdapterCapabilities.features} ids (extensible string union at runtime). */
export const MESSAGING_FEATURE = {
  TYPING_NOTIFICATION: "typing_notification",
  SILENT_REPLIES_CHANNEL_AWARE: "silent_replies_channel_aware",
} as const;

export type MessagingFeatureId = (typeof MESSAGING_FEATURE)[keyof typeof MESSAGING_FEATURE];

export interface MessagingAdapterCapabilities {
  readonly platform: string;
  readonly supports: {
    readonly markdown: boolean;
    readonly directMessages: boolean;
    readonly groupChannels: boolean;
  };
  readonly extensions: ExtensionFlags;
  /**
   * Optional transport features for core negotiation (typing indicators, prompt variants, …).
   * Unknown ids are ignored by callers that do not implement them.
   */
  readonly features?: readonly string[];
  readonly parameterSchemas: {
    readonly outboundText: JsonSchemaLike;
    readonly attachment: JsonSchemaLike;
    readonly threadReply: JsonSchemaLike;
    readonly streamChunk: JsonSchemaLike;
  };
}

export function messagingCapabilitiesHasFeature(
  caps: MessagingAdapterCapabilities | undefined,
  featureId: string,
): boolean {
  return caps?.features?.includes(featureId) ?? false;
}
