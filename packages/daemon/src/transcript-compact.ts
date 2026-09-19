import type Database from "better-sqlite3";
import {
  compactTranscriptIfNeeded,
  mergeModelInvocationOverlay,
  mergeModelInvocationParams,
  type CompactionPolicy,
  type CompactTranscriptOptions,
  type ChatMessage,
  type ChatContentPart,
  type FailoverModelClient,
} from "@shoggoth/models";
import type { ShoggothModelsConfig } from "@shoggoth/shared";
import { createSessionStore, getSessionContextSegmentId } from "./sessions/session-store";
import { recordCompaction } from "./sessions/session-stats-store";

/** Options for {@link compactSessionTranscript}; `modelsConfig` enables per-session `model_selection` merge. */
export type CompactSessionTranscriptOptions = CompactTranscriptOptions & {
  readonly modelsConfig?: ShoggothModelsConfig;
};

export function loadSessionTranscript(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content, tool_call_id, tool_calls_json
       FROM transcript_messages
       WHERE session_id = @session_id AND context_segment_id = @context_segment_id
       ORDER BY seq ASC`,
    )
    .all({
      session_id: sessionId,
      context_segment_id: contextSegmentId,
    }) as Array<{
    role: string;
    content: string | null;
    tool_call_id: string | null;
    tool_calls_json: string | null;
  }>;

  return rows.map((r) => {
    const role = r.role as ChatMessage["role"];
    const msg: ChatMessage = {
      role,
      content: r.content ?? "",
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
    };
    if (r.tool_calls_json) {
      const raw = JSON.parse(r.tool_calls_json) as Array<{
        id: string;
        name: string;
        argsJson?: string;
        arguments?: string;
      }>;
      return {
        ...msg,
        toolCalls: raw.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.argsJson ?? tc.arguments ?? "",
          ...((tc as Record<string, unknown>).thoughtSignature
            ? { thoughtSignature: (tc as Record<string, unknown>).thoughtSignature as string }
            : {}),
        })),
      };
    }
    return msg;
  });
}

export function replaceSessionTranscript(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  messages: readonly ChatMessage[],
): void {
  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM transcript_messages WHERE session_id = @session_id AND context_segment_id = @context_segment_id`,
    ).run({ session_id: sessionId, context_segment_id: contextSegmentId });
    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM transcript_messages WHERE session_id = @session_id`,
      )
      .get({ session_id: sessionId }) as { m: number };
    let seq = maxRow.m + 1;
    const ins = db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content, tool_call_id, tool_calls_json, metadata_json)
       VALUES (@session_id, @context_segment_id, @seq, @role, @content, @tool_call_id, @tool_calls_json, @metadata_json)`,
    );
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const toolCallsJson = m.toolCalls?.length
        ? JSON.stringify(
            m.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              argsJson: tc.arguments,
              ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            })),
          )
        : null;
      ins.run({
        session_id: sessionId,
        context_segment_id: contextSegmentId,
        seq,
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId ?? null,
        tool_calls_json: toolCallsJson,
        metadata_json: null,
      });
      seq += 1;
    }
  });
  run();
}

/**
 * Strip image blocks from a single message's string content for summarization.
 * If the content is a JSON-serialized ChatContentPart[] containing image blocks,
 * replaces them with `[image omitted]` text parts and re-serializes.
 * Plain string content is returned unchanged.
 */
export function stripImageBlocksFromContent(content: string): string {
  if (!content.startsWith("[")) return content;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0]?.type !== "string") {
      return content;
    }
    const parts = parsed as ChatContentPart[];
    const stripped = parts.map(
      (part): ChatContentPart =>
        part.type === "image" ? { type: "text", text: "[image omitted]" } : part,
    );
    return JSON.stringify(stripped);
  } catch {
    return content;
  }
}

/**
 * Strip thinking blocks from a single message's string content for summarization.
 * If the content is a JSON-serialized ChatContentPart[] containing thinking blocks,
 * removes them entirely and re-serializes.
 * Plain string content is returned unchanged.
 */
function stripThinkingBlocksFromContent(content: string): string {
  if (!content.startsWith("[")) return content;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0]?.type !== "string") {
      return content;
    }
    const parts = parsed as ChatContentPart[];
    const stripped = parts.filter((part) => part.type !== "thinking");
    return JSON.stringify(stripped);
  } catch {
    return content;
  }
}

/**
 * Return a copy of the messages with image blocks stripped from content,
 * suitable for sending to the summarizer model during compaction.
 */
export function stripImageBlocksForCompaction(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content !== "string" || !m.content) return m;
    const stripped = stripImageBlocksFromContent(m.content);
    if (stripped === m.content) return m;
    return { ...m, content: stripped };
  });
}

/**
 * Return a copy of the messages with thinking blocks stripped from content,
 * suitable for sending to the summarizer model during compaction.
 */
function stripThinkingBlocksForCompaction(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content !== "string" || !m.content) return m;
    const stripped = stripThinkingBlocksFromContent(m.content);
    if (stripped === m.content) return m;
    return { ...m, content: stripped };
  });
}

export async function compactSessionTranscript(
  db: Database.Database,
  sessionId: string,
  policy: CompactionPolicy,
  client: FailoverModelClient,
  options?: CompactSessionTranscriptOptions,
): Promise<{ compacted: boolean; messageCount: number }> {
  const contextSegmentId = getSessionContextSegmentId(db, sessionId);
  const rows = loadSessionTranscript(db, sessionId, contextSegmentId);
  const modelsConfig = options?.modelsConfig;
  let modelInvocation = options?.modelInvocation;
  if (modelsConfig !== undefined) {
    const row = createSessionStore(db).getById(sessionId);
    const base = mergeModelInvocationParams(modelsConfig, row?.modelSelection);
    modelInvocation = mergeModelInvocationOverlay(base, options?.modelInvocation);
  }
  // Strip image and thinking blocks before summarization to avoid sending large payloads
  // and internal reasoning to the summarizer.
  let sanitizedRows = stripImageBlocksForCompaction(rows);
  sanitizedRows = stripThinkingBlocksForCompaction(sanitizedRows);
  const result = await compactTranscriptIfNeeded(sanitizedRows, policy, client, {
    modelInvocation,
  });
  if (result.compacted) {
    replaceSessionTranscript(db, sessionId, contextSegmentId, result.messages);
    recordCompaction(db, sessionId, {
      transcriptMessageCount: result.messages.length,
    });
  }
  return { compacted: result.compacted, messageCount: result.messages.length };
}
