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
}

export interface MessagingAdapterCapabilities {
  readonly platform: string;
  readonly supports: {
    readonly markdown: boolean;
    readonly directMessages: boolean;
    readonly groupChannels: boolean;
  };
  readonly extensions: ExtensionFlags;
  readonly parameterSchemas: {
    readonly outboundText: JsonSchemaLike;
    readonly attachment: JsonSchemaLike;
    readonly threadReply: JsonSchemaLike;
    readonly streamChunk: JsonSchemaLike;
  };
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
    },
    parameterSchemas: {
      outboundText: outboundTextSchema,
      attachment: attachmentSchema,
      threadReply: threadReplySchema,
      streamChunk: streamChunkSchema,
    },
  };
}
