import type { JsonSchemaLike } from "./json-schema";
import type { McpToolDescriptor } from "./mcp-tool";

/**
 * Subset of messaging adapter flags used to build the `builtin-message` JSON schema.
 * Populated by the daemon from the active messaging platform.
 */
export interface MessageToolPlatformSlice {
  readonly attachments: boolean;
  readonly messageEdit: boolean;
  readonly messageDelete: boolean;
  readonly threadCreate: boolean;
  readonly threadDelete: boolean;
  readonly replies: boolean;
  readonly messageGet: boolean;
  readonly react: boolean;
  readonly reactions: boolean;
  readonly search: boolean;
  readonly attachmentDownload: boolean;
}

/**
 * When `slice` is set, returns the `message` tool descriptor. Schema is a **flat** object (no top-level
 * `oneOf`/`anyOf`/`allOf`) so Anthropic Messages and compatible gateways accept `input_schema`.
 * Per-action requirements are enforced by the executor.
 */
export function buildMessageToolDescriptor(slice: MessageToolPlatformSlice | undefined): McpToolDescriptor | undefined {
  if (!slice) return undefined;

  const actions: string[] = ["post"];
  if (slice.messageGet) actions.push("get");
  if (slice.messageEdit) actions.push("edit");
  if (slice.messageDelete) actions.push("delete");
  if (slice.threadCreate) actions.push("create_thread");
  if (slice.threadDelete) actions.push("delete_thread");
  if (slice.react) actions.push("react");
  if (slice.reactions) actions.push("reactions");
  if (slice.search) actions.push("search");
  if (slice.attachmentDownload) actions.push("attachment-download");

  const properties: Record<string, JsonSchemaLike> = {
    action: {
      type: "string",
      enum: actions,
      description:
        "get: read message(s). post/edit/delete/create_thread/delete_thread: message CRUD. react: add/remove emoji reaction. reactions: read reactions on a message. search: filtered message fetch by keyword/author/time. attachment-download: download a file attachment. Only actions supported by the current platform appear in action's enum.",
    },
    content: {
      type: "string",
      description: "post: message body (may be empty if attachments present). edit: replacement text.",
    },
    message_id: {
      type: "string",
      description:
        "get: fetch this message only (single-message mode). edit/delete: target message. create_thread: message to branch from. react/reactions: target message. attachment-download: message containing the attachment.",
    },
    name: {
      type: "string",
      description: "create_thread: thread name.",
    },
    thread_id: {
      type: "string",
      description: "delete_thread: thread/channel identifier.",
    },
  };

  if (slice.messageGet) {
    properties.channel_id = {
      type: "string",
      description:
        "get only: channel or thread identifier; defaults to this session's bound outbound channel when omitted.",
    };
    properties.limit = {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description:
        "get list modes: max messages to return (default 10). Ignored when message_id is set (single-message mode).",
    };
    properties.anchor_message_id = {
      type: "string",
      description:
        "get: pivot message identifier; with list_direction selects messages before, after, or around this id. Omit for latest messages.",
    };
    properties.list_direction = {
      type: "string",
      enum: ["before", "after", "around"],
      description:
        "get: required when anchor_message_id is set - before = older than anchor, after = newer, around = centered on anchor.",
    };
  }

  if (slice.replies) {
    properties.reply_to_message_id = {
      type: "string",
      description: "post only: optional platform message id to reply to.",
    };
  }
  if (slice.attachments) {
    properties.attachments = {
      type: "array",
      description: "post only: optional files as base64.",
      items: {
        type: "object",
        properties: {
          filename: { type: "string" },
          content_base64: { type: "string" },
        },
        required: ["filename", "content_base64"],
      },
    };
  }
  if (slice.threadCreate) {
    properties.auto_archive_duration_minutes = {
      type: "integer",
      enum: [60, 1440, 4320, 10080],
      description: "create_thread only: optional auto-archive minutes.",
    };
  }

  // --- Reactions ---
  if (slice.react || slice.reactions) {
    properties.emoji = {
      type: "string",
      description:
        "react: emoji to add/remove (Unicode or platform shortcode, e.g. ✅ or <:custom:123>). reactions: optional filter to a specific emoji.",
    };
  }
  if (slice.react) {
    properties.remove = {
      type: "boolean",
      description: "react only: if true, remove the reaction instead of adding it. Default false.",
    };
  }

  // --- Search ---
  if (slice.search) {
    properties.query = {
      type: "string",
      description: "search: free-text keyword search.",
    };
    properties.author_id = {
      type: "string",
      description: "search: filter to messages from a specific user id.",
    };
    properties.author_ids = {
      type: "array",
      items: { type: "string" },
      description: "search: filter to messages from any of these user ids.",
    };
    properties.before = {
      type: "string",
      description: "search: only messages before this message id or ISO timestamp.",
    };
    properties.after = {
      type: "string",
      description: "search: only messages after this message id or ISO timestamp.",
    };
    properties.from_me = {
      type: "boolean",
      description: "search: filter to messages sent by the bot/agent itself (requires author_id).",
    };
    properties.channel_ids = {
      type: "array",
      items: { type: "string" },
      description: "search: search across multiple channels. Defaults to the bound channel.",
    };
    // Extend limit description for search (max 25 for some platform search APIs)
    if (!properties.limit) {
      properties.limit = {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: "search: max results to return (default 25).",
      };
    }
  }

  // --- Attachment Download ---
  if (slice.attachmentDownload) {
    properties.filename = {
      type: "string",
      description:
        "attachment-download: specific filename to download when the message has multiple attachments.",
    };
    properties.index = {
      type: "integer",
      minimum: 0,
      description:
        "attachment-download: 0-based attachment index. Defaults to 0 if filename is not specified.",
    };
    properties.path = {
      type: "string",
      description:
        "attachment-download: local path to save the file to. Defaults to the workspace downloads directory.",
    };
  }

  return {
    name: "message",
    description:
      "Messaging surface control for this session's bound channel: read messages (get), post (optional attachments / reply), edit or delete messages, create or delete threads, add/remove reactions (react), read reactions (reactions), search messages by keyword/author/time (search), download file attachments (attachment-download). Only actions supported by the current platform appear in action's enum. Regular assistant replies are delivered by the platform and do not use this tool.",
    inputSchema: {
      type: "object",
      properties,
      required: ["action"],
    },
  };
}
