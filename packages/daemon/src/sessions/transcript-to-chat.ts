import type Database from "better-sqlite3";
import type { ChatMessage, ChatToolCall, ChatContentPart, ImageBlockCodec } from "@shoggoth/models";
import type { TranscriptMessageRow } from "./transcript-store";
import { createTranscriptStore } from "./transcript-store";

/**
 * Detects whether a content string is a JSON-serialized `ChatContentPart[]` or a plain string.
 * Returns the parsed array when valid, otherwise the original string.
 */
export function parseTranscriptContent(raw: string): string | ChatContentPart[] {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.type === "string") {
        return parsed as ChatContentPart[];
      }
    } catch { /* fall through */ }
  }
  return raw;
}

/**
 * Strip thinking blocks from content parts.
 * Returns the original content if it's a string, or filters out thinking parts if it's an array.
 */
function stripThinkingBlocks(content: string | ChatContentPart[]): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  
  const filtered = content.filter((part) => part.type !== "thinking");
  return filtered.length > 0 ? filtered : content;
}

/** Maps durable transcript rows to OpenAI-style chat messages for the model client. */
export function transcriptRowsToModelChatMessages(
  messages: readonly TranscriptMessageRow[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let seenUser = false;
  for (const m of messages) {
    if (m.role === "user") {
      let content = m.content ? parseTranscriptContent(m.content) : "";
      content = stripThinkingBlocks(content);
      if (m.createdAt && seenUser) {
        const ts = `[${m.createdAt}Z]`;
        if (typeof content === "string") {
          content = `${ts} ${content}`;
        } else {
          content = [{ type: "text" as const, text: ts }, ...content];
        }
      }
      seenUser = true;
      out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        const toolCalls: ChatToolCall[] = m.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.argsJson,
        }));
        let content = m.content ? parseTranscriptContent(m.content) : m.content;
        content = content != null ? stripThinkingBlocks(content) : content;
        out.push({
          role: "assistant",
          content,
          toolCalls,
        });
      } else {
        let content = m.content ? parseTranscriptContent(m.content) : "";
        content = stripThinkingBlocks(content);
        out.push({ role: "assistant", content });
      }
      continue;
    }
    if (m.role === "tool" && m.toolCallId) {
      let content = m.content ? parseTranscriptContent(m.content) : "";
      content = stripThinkingBlocks(content);
      out.push({
        role: "tool",
        toolCallId: m.toolCallId,
        content,
      });
    }
  }
  return out;
}

function loadTranscriptPage(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): TranscriptMessageRow[] {
  const tr = createTranscriptStore(db);
  const all: TranscriptMessageRow[] = [];
  let after = 0;
  const cap = 2000;
  for (;;) {
    const page = tr.listPage({ sessionId, contextSegmentId, afterSeq: after, limit: 200 });
    all.push(...page.messages);
    if (!page.nextCursor || all.length >= cap) break;
    after = page.nextCursor;
  }
  return all;
}

/** Chat history for the model, capped, excluding the system prompt (caller adds system). */
export function loadSessionTranscriptAsModelChat(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): ChatMessage[] {
  return transcriptRowsToModelChatMessages(loadTranscriptPage(db, sessionId, contextSegmentId));
}

/** Last non–tool-call assistant content in the transcript (final visible reply). */
export function extractLatestTranscriptAssistantText(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): string | undefined {
  const tr = createTranscriptStore(db);
  let after = 0;
  let last: string | undefined;
  for (;;) {
    const page = tr.listPage({ sessionId, contextSegmentId, afterSeq: after, limit: 200 });
    for (const m of page.messages) {
      if (m.role === "assistant" && m.content) {
        if (!m.toolCalls?.length) {
          last = m.content ?? undefined;
        }
      }
    }
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Provider capability gating — image block sanitization
// ---------------------------------------------------------------------------

/** Estimate the raw byte size of an image block from its base64 payload. */
function estimateImageBytes(part: ChatContentPart & { type: "image" }): number {
  if (part.base64) {
    // base64 encodes 3 bytes per 4 chars
    return Math.floor((part.base64.length * 3) / 4);
  }
  return 0;
}

/** Human-readable byte size (e.g. "34KB", "1.2MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Replace image content parts with a text placeholder describing the image.
 * Returns the parts array unchanged when no image parts are present.
 */
function sanitizeContentParts(parts: ChatContentPart[]): ChatContentPart[] {
  let hasImage = false;
  for (const p of parts) {
    if (p.type === "image") { hasImage = true; break; }
  }
  if (!hasImage) return parts;

  return parts.map((p) => {
    if (p.type !== "image") return p;
    const size = estimateImageBytes(p);
    const sizeStr = size > 0 ? `, ${formatBytes(size)}` : "";
    return { type: "text" as const, text: `[image: ${p.mediaType}${sizeStr}]` };
  });
}

/**
 * Strip image blocks from transcript messages when the active provider does not
 * support image input. Each image block is replaced with a text placeholder like
 * `[image: image/png, 34KB]`.
 *
 * When `codec` is undefined or `codec.supportsImageInput` is true, messages pass
 * through unchanged (no copies made).
 */
export function sanitizeTranscriptForProvider(
  messages: ChatMessage[],
  codec: ImageBlockCodec | undefined,
): ChatMessage[] {
  // Nothing to strip when the provider supports images (or no codec is available).
  if (!codec || codec.supportsImageInput) return messages;

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const sanitized = sanitizeContentParts(msg.content);
    if (sanitized === msg.content) return msg;
    return { ...msg, content: sanitized };
  });
}
