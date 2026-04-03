import type Database from "better-sqlite3";
import { getLogger } from "../logging";
const log = getLogger("transcript-to-chat");
import type { ChatMessage, ChatToolCall, ChatContentPart } from "@shoggoth/models";
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
        const imageCount = parsed.filter((p: any) => p.type === "image").length;
        if (imageCount > 0) {
          log.debug("parseTranscriptContent.image_blocks_detected", { imageCount, totalParts: parsed.length });
        }
        return parsed as ChatContentPart[];
      }
    } catch { /* fall through */ }
  }
  return raw;
}

/** Maps durable transcript rows to OpenAI-style chat messages for the model client. */
export function transcriptRowsToModelChatMessages(
  messages: readonly TranscriptMessageRow[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = m.content ? parseTranscriptContent(m.content) : "";
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
        const content = m.content ? parseTranscriptContent(m.content) : m.content;
        out.push({
          role: "assistant",
          content,
          toolCalls,
        });
      } else {
        const content = m.content ? parseTranscriptContent(m.content) : "";
        out.push({ role: "assistant", content });
      }
      continue;
    }
    if (m.role === "tool" && m.toolCallId) {
      const content = m.content ? parseTranscriptContent(m.content) : "";
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
