import type Database from "better-sqlite3";
import type { ChatMessage, ChatToolCall } from "@shoggoth/models";
import type { TranscriptMessageRow } from "./transcript-store";
import { createTranscriptStore } from "./transcript-store";

/** Maps durable transcript rows to OpenAI-style chat messages for the model client. */
export function transcriptRowsToModelChatMessages(
  messages: readonly TranscriptMessageRow[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      const meta = m.metadata as
        | { toolCalls?: { id: string; name: string; argsJson: string }[] }
        | undefined;
      if (meta?.toolCalls?.length) {
        const toolCalls: ChatToolCall[] = meta.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.argsJson,
        }));
        out.push({
          role: "assistant",
          content: m.content,
          toolCalls,
        });
      } else {
        out.push({ role: "assistant", content: m.content ?? "" });
      }
      continue;
    }
    if (m.role === "tool" && m.toolCallId) {
      out.push({
        role: "tool",
        toolCallId: m.toolCallId,
        content: m.content ?? "",
      });
    }
  }
  return out;
}

function loadTranscriptPage(db: Database.Database, sessionId: string): TranscriptMessageRow[] {
  const tr = createTranscriptStore(db);
  const all: TranscriptMessageRow[] = [];
  let after = 0;
  const cap = 2000;
  for (;;) {
    const page = tr.listPage({ sessionId, afterSeq: after, limit: 200 });
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
): ChatMessage[] {
  return transcriptRowsToModelChatMessages(loadTranscriptPage(db, sessionId));
}

/** Last non–tool-call assistant content in the transcript (final visible reply). */
export function extractLatestTranscriptAssistantText(
  db: Database.Database,
  sessionId: string,
): string | undefined {
  const tr = createTranscriptStore(db);
  let after = 0;
  let last: string | undefined;
  for (;;) {
    const page = tr.listPage({ sessionId, afterSeq: after, limit: 200 });
    for (const m of page.messages) {
      if (m.role === "assistant" && m.content) {
        const meta = m.metadata as { toolCalls?: unknown[] } | undefined;
        if (!meta?.toolCalls?.length) {
          last = m.content ?? undefined;
        }
      }
    }
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  return last;
}
