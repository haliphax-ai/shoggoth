import type Database from "better-sqlite3";
import { getLogger } from "../logging";

export interface ToolCallEntry {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
}

export interface TranscriptMessageRow {
  readonly seq: number;
  readonly role: string;
  readonly content: string | null;
  readonly toolCallId: string | null;
  readonly toolCalls?: readonly ToolCallEntry[];
  readonly metadata?: unknown;
  readonly createdAt?: string;
}

export interface AppendTranscriptInput {
  readonly sessionId: string;
  /** Must match {@link SessionRow.contextSegmentId} for the session. */
  readonly contextSegmentId: string;
  readonly role: string;
  readonly content?: string | null;
  readonly toolCallId?: string | null;
  readonly toolCalls?: readonly ToolCallEntry[];
  readonly metadata?: unknown;
  readonly createdAt?: string;
  /** Raw trusted system context, stored separately for structured access. */
  readonly systemContext?: unknown;
}

export interface TranscriptStore {
  append(input: AppendTranscriptInput): { seq: number };
  listPage(input: {
    sessionId: string;
    contextSegmentId: string;
    afterSeq: number;
    limit: number;
  }): { messages: TranscriptMessageRow[]; nextCursor: number | undefined };
  /** Removes all transcript rows for a session + segment (`new` / `reset` commands). */
  deleteForSessionSegment(sessionId: string, contextSegmentId: string): number;
}

export function createTranscriptStore(db: Database.Database): TranscriptStore {
    /** Global per `session_id`; unique key is `(session_id, seq)`. */
  const nextSeq = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM transcript_messages WHERE session_id = @session_id
  `);

  const insert = db.prepare(`
    INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content, tool_call_id, tool_calls_json, metadata_json, system_context_json)
    VALUES (@session_id, @context_segment_id, @seq, @role, @content, @tool_call_id, @tool_calls_json, @metadata_json, @system_context_json)
  `);

  const selectPage = db.prepare(`
    SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json, created_at
    FROM transcript_messages
    WHERE session_id = @session_id AND context_segment_id = @context_segment_id AND seq > @after_seq
    ORDER BY seq ASC
    LIMIT @limit
  `);

  const delSegment = db.prepare(`
    DELETE FROM transcript_messages
    WHERE session_id = @session_id AND context_segment_id = @context_segment_id
  `);

  const selectRecent = db.prepare(`
    SELECT role, tool_call_id, tool_calls_json
    FROM transcript_messages
    WHERE session_id = @session_id AND context_segment_id = @context_segment_id
    ORDER BY seq DESC
    LIMIT 50
  `);

  function insertRow(sessionId: string, contextSegmentId: string, role: string, content: string | null, toolCallId: string | null, toolCallsJson: string | null, metadataJson: string | null, systemContextJson: string | null): number {
    const row = nextSeq.get({ session_id: sessionId }) as { n: number };
    const seq = row.n;
    insert.run({
      session_id: sessionId,
      context_segment_id: contextSegmentId,
      seq,
      role,
      content,
      tool_call_id: toolCallId,
      tool_calls_json: toolCallsJson,
      metadata_json: metadataJson,
      system_context_json: systemContextJson,
    });
    return seq;
  }

  function repairOrphaned(sessionId: string, contextSegmentId: string): void {
    const rows = selectRecent.all({
      session_id: sessionId,
      context_segment_id: contextSegmentId,
    }) as Array<{ role: string; tool_call_id: string | null; tool_calls_json: string | null }>;

    const collectedToolResultIds = new Set<string>();
    let expectedIds: string[] | undefined;

    for (const r of rows) {
      if (r.role === "tool" && r.tool_call_id) {
        collectedToolResultIds.add(r.tool_call_id);
      } else if (r.role === "assistant" && r.tool_calls_json) {
        const calls = JSON.parse(r.tool_calls_json) as Array<{ id: string }>;
        expectedIds = calls.map((c) => c.id);
        break;
      } else {
        // Hit a non-tool, non-assistant-with-tool-calls row — no orphans possible
        break;
      }
    }

    if (!expectedIds) return;
    const missing = expectedIds.filter((id) => !collectedToolResultIds.has(id));
    if (missing.length === 0) return;

    const log = getLogger("transcript-store");
    log.info("transcript.orphaned_tool_calls_repaired", { sessionId, toolCallIds: missing, count: missing.length });
    for (const id of missing) {
      insertRow(sessionId, contextSegmentId, "tool", "[Tool call aborted — no result available]", id, null, null, null);
    }
  }

  return {
    append(input) {
      if (input.role === "tool" && input.toolCallId) {
        // Tool result — let it through directly
      } else {
        repairOrphaned(input.sessionId, input.contextSegmentId);
      }

      const seq = insertRow(
        input.sessionId,
        input.contextSegmentId,
        input.role,
        input.content ?? null,
        input.toolCallId ?? null,
        input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
        input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        input.systemContext !== undefined ? JSON.stringify(input.systemContext) : null,
      );

      return { seq };
    },

    listPage({ sessionId, contextSegmentId, afterSeq, limit }) {
      const rows = selectPage.all({
        session_id: sessionId,
        context_segment_id: contextSegmentId,
        after_seq: afterSeq,
        limit,
      }) as {
        seq: number;
        role: string;
        content: string | null;
        tool_call_id: string | null;
        tool_calls_json: string | null;
        metadata_json: string | null;
        created_at: string;
      }[];

      const messages: TranscriptMessageRow[] = rows.map((r) => ({
        seq: r.seq,
        role: r.role,
        content: r.content,
        toolCallId: r.tool_call_id,
        toolCalls: r.tool_calls_json
          ? (JSON.parse(r.tool_calls_json) as ToolCallEntry[])
          : undefined,
        metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as unknown) : undefined,
        createdAt: r.created_at,
      }));

      const last = messages[messages.length - 1];
      const nextCursor =
        messages.length >= limit && last !== undefined ? last.seq : undefined;

      return { messages, nextCursor };
    },

    deleteForSessionSegment(sessionId, contextSegmentId) {
      const info = delSegment.run({
        session_id: sessionId.trim(),
        context_segment_id: contextSegmentId.trim(),
      });
      return Number(info.changes);
    },
  };
}
