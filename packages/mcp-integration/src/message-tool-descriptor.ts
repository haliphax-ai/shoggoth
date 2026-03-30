import type { JsonSchemaLike } from "./json-schema";
import type { McpToolDescriptor } from "./mcp-tool";

/**
 * Subset of messaging adapter flags used to build the `builtin.message` JSON schema.
 * Populated by the daemon from the active platform (e.g. Discord).
 */
export interface MessageToolPlatformSlice {
  readonly attachments: boolean;
  readonly messageEdit: boolean;
  readonly messageDelete: boolean;
  readonly threadCreate: boolean;
  readonly threadDelete: boolean;
  readonly replies: boolean;
  readonly messageGet: boolean;
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

  const properties: Record<string, JsonSchemaLike> = {
    action: {
      type: "string",
      enum: actions,
      description:
        "get: read message(s) — use message_id alone for one message; or limit (default 10) for latest messages in the channel; or anchor_message_id + list_direction (before|after|around) for messages relative to that id (Discord). post/edit/delete/create_thread/delete_thread as documented in other fields. Normal assistant replies use platform transport, not this tool.",
    },
    content: {
      type: "string",
      description: "post: message body (may be empty if attachments present). edit: replacement text.",
    },
    message_id: {
      type: "string",
      description:
        "get: fetch this message only (single-message mode). edit/delete: target message. create_thread: message to branch from.",
    },
    name: {
      type: "string",
      description: "create_thread: thread name (Discord).",
    },
    thread_id: {
      type: "string",
      description: "delete_thread: thread channel snowflake (Discord).",
    },
  };

  if (slice.messageGet) {
    properties.channel_id = {
      type: "string",
      description:
        "get only: Discord channel or thread snowflake; defaults to this session’s bound outbound channel when omitted.",
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
        "get: pivot snowflake; with list_direction selects messages before, after, or around this id (Discord GET /messages). Omit for latest messages.",
    };
    properties.list_direction = {
      type: "string",
      enum: ["before", "after", "around"],
      description:
        "get: required when anchor_message_id is set — before = older than anchor, after = newer, around = centered on anchor.",
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
      description: "create_thread only: optional auto-archive minutes (Discord).",
    };
  }

  return {
    name: "message",
    description:
      "Messaging surface control for this session’s bound channel: read messages (get), post (optional attachments / reply), edit or delete messages, create or delete threads. Only actions supported by the current platform appear in action’s enum. Regular assistant replies are delivered by the platform and do not use this tool.",
    inputSchema: {
      type: "object",
      properties,
      required: ["action"],
    },
  };
}
