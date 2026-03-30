import type { MessagingAdapterCapabilities } from "../capabilities";
import type { DiscordCreateMessageBody, DiscordMessageUploadFile, DiscordRestTransport } from "./transport";

export interface DiscordMessageToolDeps {
  readonly capabilities: MessagingAdapterCapabilities;
  readonly transport: DiscordRestTransport;
  readonly sessionToChannel: (sessionId: string) => string | undefined;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v.trim();
}

function optStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

function summarizeDiscordApiMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const author = raw.author;
  let authorId: string | undefined;
  let authorUsername: string | undefined;
  let bot: boolean | undefined;
  if (author && typeof author === "object" && !Array.isArray(author)) {
    const a = author as Record<string, unknown>;
    if (typeof a.id === "string") authorId = a.id;
    if (typeof a.username === "string") authorUsername = a.username;
    if (typeof a.bot === "boolean") bot = a.bot;
  }
  const att = raw.attachments;
  const attachments = Array.isArray(att) ? att : [];
  const filenames: string[] = [];
  for (const x of attachments) {
    if (x && typeof x === "object" && !Array.isArray(x) && typeof (x as { filename?: string }).filename === "string") {
      filenames.push((x as { filename: string }).filename);
    }
  }
  return {
    id: raw.id,
    channel_id: raw.channel_id,
    content: typeof raw.content === "string" ? raw.content : "",
    timestamp: raw.timestamp,
    author_id: authorId,
    author_username: authorUsername,
    bot,
    attachment_count: filenames.length,
    attachment_filenames: filenames,
  };
}

function clampGetLimit(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(100, Math.max(1, Math.trunc(v)));
  }
  return 10;
}

function decodeBase64File(
  raw: string,
  filename: string,
): DiscordMessageUploadFile {
  let b: Buffer;
  try {
    b = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`attachments[].content_base64 for ${filename} is not valid base64`);
  }
  if (b.length === 0) {
    throw new Error(`attachments[].content_base64 for ${filename} decoded to empty buffer`);
  }
  /** Discord message max ~25 MiB per file; keep a conservative cap. */
  const max = 24 * 1024 * 1024;
  if (b.length > max) {
    throw new Error(`attachment ${filename} exceeds size limit`);
  }
  return { filename, data: new Uint8Array(b) };
}

/**
 * Executes the agent `builtin.message` tool against Discord REST for the channel mapped to
 * `sessionId`. Validates each action against {@link MessagingAdapterCapabilities.extensions}.
 */
export async function executeDiscordMessageToolAction(
  deps: DiscordMessageToolDeps,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sid = sessionId.trim();
  if (!sid) {
    return { ok: false, error: "invalid session" };
  }
  const boundChannel = deps.sessionToChannel(sid);

  const action = args.action;
  if (typeof action !== "string" || !action.trim()) {
    return { ok: false, error: "action required" };
  }
  const a = action.trim();
  const { capabilities: caps, transport: t } = deps;
  const x = caps.extensions;

  try {
    if (a === "get") {
      if (!x.messageGet) {
        return { ok: false, error: "get not supported on this platform" };
      }
      const targetChannel = optStr(args.channel_id) ?? boundChannel;
      if (!targetChannel) {
        return {
          ok: false,
          error: "get needs a channel: set channel_id or use a session bound to a channel",
          sessionId: sid,
        };
      }

      const singleId = optStr(args.message_id);
      const anchor = optStr(args.anchor_message_id);
      const dirRaw = optStr(args.list_direction);
      const limit = clampGetLimit(args.limit);

      if (singleId) {
        const raw = await t.getMessage(targetChannel, singleId);
        return {
          ok: true,
          channel_id: targetChannel,
          messages: [summarizeDiscordApiMessage(raw)],
        };
      }

      if (anchor) {
        if (dirRaw !== "before" && dirRaw !== "after" && dirRaw !== "around") {
          return {
            ok: false,
            error: "anchor_message_id requires list_direction: before | after | around",
          };
        }
        const q: { limit: number; before?: string; after?: string; around?: string } = { limit };
        if (dirRaw === "before") q.before = anchor;
        else if (dirRaw === "after") q.after = anchor;
        else q.around = anchor;
        const rows = await t.getChannelMessages(targetChannel, q);
        return {
          ok: true,
          channel_id: targetChannel,
          messages: rows.map(summarizeDiscordApiMessage),
        };
      }

      if (dirRaw) {
        return {
          ok: false,
          error: "list_direction without anchor_message_id; omit both for latest messages, or set anchor_message_id",
        };
      }

      const rows = await t.getChannelMessages(targetChannel, { limit });
      return {
        ok: true,
        channel_id: targetChannel,
        messages: rows.map(summarizeDiscordApiMessage),
      };
    }

    if (!boundChannel) {
      return { ok: false, error: "no_discord_channel_for_session", sessionId: sid };
    }
    const channelId = boundChannel;

    if (a === "post") {
      const content = typeof args.content === "string" ? args.content : "";
      const replyTo = optStr(args.reply_to_message_id);
      if (replyTo && !x.replies) {
        return { ok: false, error: "reply_to_message_id not supported on this platform" };
      }

      const attRaw = args.attachments;
      let files: DiscordMessageUploadFile[] = [];
      if (attRaw !== undefined) {
        if (!x.attachments) {
          return { ok: false, error: "attachments not supported on this platform" };
        }
        if (!Array.isArray(attRaw)) {
          return { ok: false, error: "attachments must be an array" };
        }
        for (const row of attRaw) {
          if (row === null || typeof row !== "object" || Array.isArray(row)) {
            return { ok: false, error: "each attachment must be an object" };
          }
          const o = row as Record<string, unknown>;
          const filename = str(o.filename, "attachments[].filename");
          const b64 = o.content_base64;
          if (typeof b64 !== "string" || !b64.trim()) {
            return { ok: false, error: "attachments[].content_base64 required" };
          }
          files.push(decodeBase64File(b64.trim(), filename));
        }
      }

      if (!content && files.length === 0) {
        return { ok: false, error: "post requires content and/or attachments" };
      }

      const body: DiscordCreateMessageBody = replyTo
        ? { content, message_reference: { message_id: replyTo } }
        : { content };

      if (files.length > 0) {
        const { id } = await t.createMessageWithFiles(channelId, body, files);
        return { ok: true, message_id: id, channel_id: channelId };
      }
      const { id } = await t.createMessage(channelId, body);
      return { ok: true, message_id: id, channel_id: channelId };
    }

    if (a === "edit") {
      if (!x.messageEdit) {
        return { ok: false, error: "edit not supported on this platform" };
      }
      const messageId = str(args.message_id, "message_id");
      const content = typeof args.content === "string" ? args.content : "";
      await t.editMessage(channelId, messageId, { content });
      return { ok: true, message_id: messageId, channel_id: channelId };
    }

    if (a === "delete") {
      if (!x.messageDelete) {
        return { ok: false, error: "delete not supported on this platform" };
      }
      const messageId = str(args.message_id, "message_id");
      await t.deleteMessage(channelId, messageId);
      return { ok: true, message_id: messageId, channel_id: channelId };
    }

    if (a === "create_thread") {
      if (!x.threadCreate) {
        return { ok: false, error: "create_thread not supported on this platform" };
      }
      const messageId = str(args.message_id, "message_id");
      const name = str(args.name, "name");
      const dur = args.auto_archive_duration_minutes;
      let auto_archive_duration: 60 | 1440 | 4320 | 10080 | undefined;
      if (dur !== undefined) {
        if (dur !== 60 && dur !== 1440 && dur !== 4320 && dur !== 10080) {
          return {
            ok: false,
            error: "auto_archive_duration_minutes must be one of 60, 1440, 4320, 10080",
          };
        }
        auto_archive_duration = dur;
      }
      const { id } = await t.createThreadFromMessage(channelId, messageId, {
        name,
        ...(auto_archive_duration !== undefined ? { auto_archive_duration } : {}),
      });
      return { ok: true, thread_id: id, parent_channel_id: channelId, message_id: messageId };
    }

    if (a === "delete_thread") {
      if (!x.threadDelete) {
        return { ok: false, error: "delete_thread not supported on this platform" };
      }
      const threadId = str(args.thread_id, "thread_id");
      await t.deleteChannel(threadId);
      return { ok: true, thread_id: threadId };
    }

    return { ok: false, error: `unknown action: ${a}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
