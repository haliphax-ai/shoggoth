import type { MessagingAdapterCapabilities } from "./capabilities";
import type {
  MessageToolTransport,
  CreateMessageBody,
  MessageUploadFile,
} from "./message-tool-transport";

export interface AttachmentDownloadResult {
  readonly ok: true;
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string | undefined;
  readonly size: number;
  readonly totalAttachments: number;
}

export interface MessageToolDeps {
  readonly capabilities: MessagingAdapterCapabilities;
  readonly transport: MessageToolTransport;
  readonly sessionToChannel: (sessionId: string) => string | undefined;
  readonly sessionToGuild?: (sessionId: string) => string | undefined;
  readonly downloadFile?: (url: string, destPath: string) => Promise<number>;
  readonly getSessionWorkspace?: (sessionId: string) => string | undefined;
  readonly readWorkspaceFile?: (sessionId: string, relativePath: string) => Promise<Buffer>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} must be a non-empty string`);
  return v.trim();
}

function optStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

export function summarizeApiMessage(raw: Record<string, unknown>): Record<string, unknown> {
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
    if (
      x &&
      typeof x === "object" &&
      !Array.isArray(x) &&
      typeof (x as { filename?: string }).filename === "string"
    ) {
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
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(100, Math.max(1, Math.trunc(v)));
  return 10;
}

function clampSearchLimit(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(25, Math.max(1, Math.trunc(v)));
  return 25;
}

function sanitizeFilename(raw: string): string {
  return (
    raw
      .replace(/\.\./g, "_")
      .replace(/[/\\]/g, "_")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, "")
      .trim() || "attachment"
  );
}

function decodeBase64File(raw: string, filename: string): MessageUploadFile {
  let b: Buffer;
  try {
    b = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`attachments[].content_base64 for ${filename} is not valid base64`);
  }
  if (b.length === 0)
    throw new Error(`attachments[].content_base64 for ${filename} decoded to empty buffer`);
  const max = 24 * 1024 * 1024;
  if (b.length > max) throw new Error(`attachment ${filename} exceeds size limit`);
  return { filename, data: new Uint8Array(b) };
}

function decodePathFile(buf: Buffer, filename: string): MessageUploadFile {
  if (buf.length === 0)
    throw new Error(`attachments[].content_path for ${filename} read empty file`);
  const max = 24 * 1024 * 1024;
  if (buf.length > max) throw new Error(`attachment ${filename} exceeds size limit`);
  return { filename, data: new Uint8Array(buf) };
}

export async function executeMessageToolAction(
  deps: MessageToolDeps,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sid = sessionId.trim();
  if (!sid) return { ok: false, error: "invalid session" };
  const boundChannel = deps.sessionToChannel(sid);

  const action = args.action;
  if (typeof action !== "string" || !action.trim()) return { ok: false, error: "action required" };
  const a = action.trim();
  const { capabilities: caps, transport: t } = deps;
  const x = caps.extensions;

  try {
    if (a === "get") {
      if (!x.messageGet) return { ok: false, error: "get not supported on this platform" };
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
          messages: [summarizeApiMessage(raw)],
        };
      }
      if (anchor) {
        if (dirRaw !== "before" && dirRaw !== "after" && dirRaw !== "around") {
          return {
            ok: false,
            error: "anchor_message_id requires list_direction: before | after | around",
          };
        }
        const q: {
          limit: number;
          before?: string;
          after?: string;
          around?: string;
        } = { limit };
        if (dirRaw === "before") q.before = anchor;
        else if (dirRaw === "after") q.after = anchor;
        else q.around = anchor;
        const rows = await t.getChannelMessages(targetChannel, q);
        return {
          ok: true,
          channel_id: targetChannel,
          messages: rows.map(summarizeApiMessage),
        };
      }
      if (dirRaw) {
        return {
          ok: false,
          error:
            "list_direction without anchor_message_id; omit both for latest messages, or set anchor_message_id",
        };
      }
      const rows = await t.getChannelMessages(targetChannel, { limit });
      return {
        ok: true,
        channel_id: targetChannel,
        messages: rows.map(summarizeApiMessage),
      };
    }

    if (!boundChannel) return { ok: false, error: "no_channel_for_session", sessionId: sid };
    const channelId = boundChannel;

    if (a === "post") {
      const content = typeof args.content === "string" ? args.content : "";
      const replyTo = optStr(args.reply_to_message_id);
      if (replyTo && !x.replies)
        return {
          ok: false,
          error: "reply_to_message_id not supported on this platform",
        };

      const attRaw = args.attachments;
      const files: MessageUploadFile[] = [];
      if (attRaw !== undefined) {
        if (!x.attachments)
          return {
            ok: false,
            error: "attachments not supported on this platform",
          };
        if (!Array.isArray(attRaw)) return { ok: false, error: "attachments must be an array" };
        for (const row of attRaw) {
          if (row === null || typeof row !== "object" || Array.isArray(row))
            return { ok: false, error: "each attachment must be an object" };
          const o = row as Record<string, unknown>;
          const filename = str(o.filename, "attachments[].filename");
          const b64 = optStr(o.content_base64);
          const path = optStr(o.content_path);

          // Mutually exclusive: exactly one of content_base64 or content_path required
          if (b64 && path) {
            return {
              ok: false,
              error: "attachments[]: content_base64 and content_path are mutually exclusive",
            };
          }
          if (!b64 && !path) {
            return {
              ok: false,
              error: "attachments[]: either content_base64 or content_path is required",
            };
          }

          if (path) {
            // Read from workspace path
            if (!deps.readWorkspaceFile) {
              return {
                ok: false,
                error: "attachments[].content_path requires readWorkspaceFile handler",
              };
            }
            const buf = await deps.readWorkspaceFile(sid, path);
            files.push(decodePathFile(buf, filename));
          } else {
            // Use base64
            files.push(decodeBase64File(b64!, filename));
          }
        }
      }
      if (!content && files.length === 0)
        return { ok: false, error: "post requires content and/or attachments" };

      const body: CreateMessageBody = replyTo
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
      if (!x.messageEdit) return { ok: false, error: "edit not supported on this platform" };
      const messageId = str(args.message_id, "message_id");
      const content = typeof args.content === "string" ? args.content : "";
      await t.editMessage(channelId, messageId, { content });
      return { ok: true, message_id: messageId, channel_id: channelId };
    }

    if (a === "delete") {
      if (!x.messageDelete) return { ok: false, error: "delete not supported on this platform" };
      const messageId = str(args.message_id, "message_id");
      await t.deleteMessage(channelId, messageId);
      return { ok: true, message_id: messageId, channel_id: channelId };
    }

    if (a === "create_thread") {
      if (!x.threadCreate)
        return {
          ok: false,
          error: "create_thread not supported on this platform",
        };
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
      return {
        ok: true,
        thread_id: id,
        parent_channel_id: channelId,
        message_id: messageId,
      };
    }

    if (a === "delete_thread") {
      if (!x.threadDelete)
        return {
          ok: false,
          error: "delete_thread not supported on this platform",
        };
      const threadId = str(args.thread_id, "thread_id");
      await t.deleteChannel(threadId);
      return { ok: true, thread_id: threadId };
    }

    if (a === "react") {
      if (!x.react) return { ok: false, error: "react not supported on this platform" };
      const messageId = str(args.message_id, "message_id");
      const emoji = str(args.emoji, "emoji");
      const remove = args.remove === true;
      if (remove) await t.deleteMessageReaction(channelId, messageId, emoji);
      else await t.createMessageReaction(channelId, messageId, emoji);
      return {
        ok: true,
        message_id: messageId,
        channel_id: channelId,
        emoji,
        removed: remove,
      };
    }

    if (a === "choice") {
      if (!x.react) return { ok: false, error: "choice not supported on this platform" };
      const choicesRaw = args.choices;
      if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
        return {
          ok: false,
          error: "choices must be a non-empty array of { emoji, label }",
        };
      }
      const choices: { emoji: string; label: string }[] = [];
      for (const c of choicesRaw) {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          return {
            ok: false,
            error: "each choice must be an object with emoji and label",
          };
        }
        const o = c as Record<string, unknown>;
        const emoji = typeof o.emoji === "string" ? o.emoji.trim() : "";
        const label = typeof o.label === "string" ? o.label.trim() : "";
        if (!emoji || !label)
          return {
            ok: false,
            error: "each choice requires non-empty emoji and label",
          };
        choices.push({ emoji, label });
      }
      const preamble = typeof args.content === "string" ? args.content.trim() : "";
      const legendLines = choices.map((c) => `${c.emoji} ${c.label}`);
      const body = [...(preamble ? [preamble, ""] : []), "React to choose:", ...legendLines].join(
        "\n",
      );
      const { id } = await t.createMessage(channelId, { content: body });
      for (const c of choices) {
        try {
          await t.createMessageReaction(channelId, id, c.emoji);
        } catch {
          /* best-effort */
        }
      }
      return {
        ok: true,
        message_id: id,
        channel_id: channelId,
        choices: choices.length,
      };
    }

    if (a === "reactions") {
      if (!x.reactions) return { ok: false, error: "reactions not supported on this platform" };
      const messageId = str(args.message_id, "message_id");
      const emojiFilter = optStr(args.emoji);
      if (emojiFilter) {
        const users = await t.getMessageReactions(channelId, messageId, emojiFilter);
        const summarized = users.map((u) => ({
          id: typeof u.id === "string" ? u.id : undefined,
          username: typeof u.username === "string" ? u.username : undefined,
          bot: typeof u.bot === "boolean" ? u.bot : undefined,
        }));
        return {
          ok: true,
          message_id: messageId,
          channel_id: channelId,
          reactions: [{ emoji: emojiFilter, count: summarized.length, users: summarized }],
        };
      }
      const raw = await t.getMessage(channelId, messageId);
      const rawReactions = Array.isArray(raw.reactions) ? raw.reactions : [];
      const reactions = rawReactions.map((r: Record<string, unknown>) => {
        const emojiObj = r.emoji as Record<string, unknown> | undefined;
        const name = emojiObj && typeof emojiObj.name === "string" ? emojiObj.name : "?";
        const emojiId = emojiObj && typeof emojiObj.id === "string" ? emojiObj.id : undefined;
        return {
          emoji: emojiId ? `${name}:${emojiId}` : name,
          count: typeof r.count === "number" ? r.count : 0,
          me: typeof r.me === "boolean" ? r.me : false,
        };
      });
      return {
        ok: true,
        message_id: messageId,
        channel_id: channelId,
        reactions,
      };
    }

    if (a === "search") {
      if (!x.search) return { ok: false, error: "search not supported on this platform" };
      const guildId = deps.sessionToGuild?.(sid);
      if (!guildId)
        return {
          ok: false,
          error: "search requires a guild context; not available for DM sessions",
        };

      const query = optStr(args.query);
      const authorId = optStr(args.author_id);
      const authorIdsRaw = args.author_ids;
      const before = optStr(args.before);
      const after = optStr(args.after);
      const fromMe = args.from_me;
      const limit = clampSearchLimit(args.limit);
      const channelIdsRaw = args.channel_ids;

      let authorIds: string[] | undefined;
      if (authorId || (Array.isArray(authorIdsRaw) && authorIdsRaw.length > 0)) {
        authorIds = [];
        if (authorId) authorIds.push(authorId);
        if (Array.isArray(authorIdsRaw)) {
          for (const id of authorIdsRaw) {
            if (typeof id === "string" && id.trim()) authorIds.push(id.trim());
          }
        }
      }
      if (fromMe === true && !authorIds) {
        return {
          ok: false,
          error: "from_me requires the bot's own user id; pass it via author_id instead",
        };
      }

      let channelIds: string[] | undefined;
      if (Array.isArray(channelIdsRaw) && channelIdsRaw.length > 0) {
        channelIds = channelIdsRaw
          .filter((c: unknown) => typeof c === "string" && c.trim())
          .map((c: unknown) => (c as string).trim());
      } else {
        channelIds = [channelId];
      }

      const searchResult = await t.searchMessages(guildId, {
        content: query,
        author_id: authorIds && authorIds.length === 1 ? authorIds[0] : authorIds,
        channel_id: channelIds.length === 1 ? channelIds[0] : channelIds,
        min_id: after,
        max_id: before,
        limit,
      });

      const messages = searchResult.messages
        .map((group) => (group.length > 0 ? group[0]! : undefined))
        .filter((m): m is Record<string, unknown> => m !== undefined)
        .map(summarizeApiMessage);

      return {
        ok: true,
        channel_id: channelId,
        total_results: searchResult.total_results,
        messages,
      };
    }

    if (a === "attachment-download") {
      if (!x.attachmentDownload)
        return {
          ok: false,
          error: "attachment-download not supported on this platform",
        };
      if (!deps.downloadFile)
        return {
          ok: false,
          error: "attachment download not configured (no downloadFile handler)",
        };

      const messageId = str(args.message_id, "message_id");
      const filenameFilter = optStr(args.filename);
      const indexRaw = args.index;
      const destPath = optStr(args.path);

      const raw = await t.getMessage(channelId, messageId);
      const rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : [];
      if (rawAttachments.length === 0)
        return {
          ok: false,
          error: "message has no attachments",
          message_id: messageId,
        };

      let attachment: Record<string, unknown> | undefined;
      if (filenameFilter) {
        attachment = rawAttachments.find(
          (a: Record<string, unknown>) =>
            typeof a.filename === "string" && a.filename === filenameFilter,
        );
        if (!attachment) {
          const available = rawAttachments
            .map((a: Record<string, unknown>) => a.filename)
            .filter((f: unknown) => typeof f === "string");
          return {
            ok: false,
            error: `attachment "${filenameFilter}" not found`,
            available_filenames: available,
            total_attachments: rawAttachments.length,
          };
        }
      } else {
        const idx =
          typeof indexRaw === "number" && Number.isFinite(indexRaw) ? Math.trunc(indexRaw) : 0;
        if (idx < 0 || idx >= rawAttachments.length) {
          return {
            ok: false,
            error: `attachment index ${idx} out of range (0..${rawAttachments.length - 1})`,
            total_attachments: rawAttachments.length,
          };
        }
        attachment = rawAttachments[idx] as Record<string, unknown>;
      }

      const url = typeof attachment!.url === "string" ? attachment!.url : undefined;
      if (!url) return { ok: false, error: "attachment has no URL" };

      const filename =
        typeof attachment!.filename === "string" ? attachment!.filename : "attachment";
      const contentType =
        typeof attachment!.content_type === "string" ? attachment!.content_type : undefined;
      const sizeBytes = typeof attachment!.size === "number" ? attachment!.size : undefined;

      const maxSize = 25 * 1024 * 1024;
      if (sizeBytes !== undefined && sizeBytes > maxSize) {
        return {
          ok: false,
          error: `attachment too large (${sizeBytes} bytes, max ${maxSize})`,
          filename,
          size: sizeBytes,
        };
      }

      const safeName = sanitizeFilename(filename);
      let finalPath = destPath ?? safeName;
      if (finalPath && !finalPath.startsWith("/")) {
        const workspace = deps.getSessionWorkspace?.(sid);
        if (workspace) finalPath = `${workspace.replace(/\/+$/, "")}/${finalPath}`;
      }

      const bytesWritten = await deps.downloadFile(url, finalPath);
      return {
        ok: true,
        path: finalPath,
        filename: safeName,
        mimeType: contentType,
        size: bytesWritten,
        totalAttachments: rawAttachments.length,
      } satisfies AttachmentDownloadResult;
    }

    return { ok: false, error: `unknown action: ${a}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
