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
  /** Agent `message` tool: read message(s) via platform API (e.g. Discord GET message / channel messages). */
  readonly messageGet: boolean;
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

const outboundTextSchema: JsonSchemaLike = {
  type: "object",
  description: "Plain or markdown outbound text for Discord messages",
  properties: {
    content: { type: "string", maxLength: 2000 },
    suppressEmbeds: { type: "boolean" },
  },
  required: ["content"],
};

const attachmentSchema: JsonSchemaLike = {
  type: "object",
  description: "Discord attachment reference (URL upload flow is adapter-specific)",
  properties: {
    filename: { type: "string" },
    url: { type: "string", description: "HTTPS URL for hosted attachment" },
    description: { type: "string" },
  },
  required: ["filename"],
};

const threadReplySchema: JsonSchemaLike = {
  type: "object",
  description: "Reply in thread or to parent message",
  properties: {
    threadId: { type: "string" },
    messageReferenceId: { type: "string" },
  },
};

const streamChunkSchema: JsonSchemaLike = {
  type: "object",
  description: "Streaming edit: full replacement content for message PATCH",
  properties: {
    content: { type: "string", maxLength: 2000 },
    sequence: { type: "integer", maximum: 1_000_000, description: "monotonic chunk index" },
  },
  required: ["content", "sequence"],
};

export function discordCapabilityDescriptor(): MessagingAdapterCapabilities {
  return {
    platform: "discord",
    supports: {
      markdown: true,
      directMessages: true,
      groupChannels: true,
    },
    extensions: {
      attachments: true,
      threads: true,
      replies: true,
      reactionsInbound: true,
      streamingOutbound: true,
      messageEdit: true,
      messageDelete: true,
      threadCreate: true,
      threadDelete: true,
      messageGet: true,
    },
    features: [MESSAGING_FEATURE.TYPING_NOTIFICATION, MESSAGING_FEATURE.SILENT_REPLIES_CHANNEL_AWARE],
    parameterSchemas: {
      outboundText: outboundTextSchema,
      attachment: attachmentSchema,
      threadReply: threadReplySchema,
      streamChunk: streamChunkSchema,
    },
  };
}
