import { MESSAGING_FEATURE, type MessagingAdapterCapabilities } from "@shoggoth/messaging";
export type { MessagingAdapterCapabilities } from "@shoggoth/messaging";

const outboundTextSchema = {
  type: "object",
  description: "Plain or markdown outbound text for Discord messages",
  properties: {
    content: { type: "string", maxLength: 2000 },
    suppressEmbeds: { type: "boolean" },
  },
  required: ["content"],
} as const;

const attachmentSchema = {
  type: "object",
  description: "Discord attachment reference (URL upload flow is adapter-specific)",
  properties: {
    filename: { type: "string" },
    url: { type: "string", description: "HTTPS URL for hosted attachment" },
    description: { type: "string" },
  },
  required: ["filename"],
} as const;

const threadReplySchema = {
  type: "object",
  description: "Reply in thread or to parent message",
  properties: {
    threadId: { type: "string" },
    messageReferenceId: { type: "string" },
  },
} as const;

const streamChunkSchema = {
  type: "object",
  description: "Streaming edit: full replacement content for message PATCH",
  properties: {
    content: { type: "string", maxLength: 2000 },
    sequence: {
      type: "integer",
      maximum: 1_000_000,
      description: "monotonic chunk index",
    },
  },
  required: ["content", "sequence"],
} as const;

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
      react: true,
      reactions: true,
      search: true,
      attachmentDownload: true,
      pin: true,
    },
    features: [
      MESSAGING_FEATURE.TYPING_NOTIFICATION,
      MESSAGING_FEATURE.SILENT_REPLIES_CHANNEL_AWARE,
    ],
    parameterSchemas: {
      outboundText: outboundTextSchema,
      attachment: attachmentSchema,
      threadReply: threadReplySchema,
      streamChunk: streamChunkSchema,
    },
  };
}
