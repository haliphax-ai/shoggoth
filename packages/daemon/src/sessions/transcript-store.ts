import type Database from "better-sqlite3";

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
    INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content, tool_call_id, tool_calls_json, metadata_json)
    VALUES (@session_id, @context_segment_id, @seq, @role, @content, @tool_call_id, @tool_calls_json, @metadata_json)
  `);

  const selectPage = db.prepare(`
    SELECT seq, role, content, tool_call_id, tool_calls_json, metadata_json
    FROM transcript_messages
    WHERE session_id = @session_id AND context_segment_id = @context_segment_id AND seq > @after_seq
    ORDER BY seq ASC
    LIMIT @limit
  `);

  const delSegment = db.prepare(`
    DELETE FROM transcript_messages
    WHERE session_id = @session_id AND context_segment_id = @context_segment_id
  `);

  return {
    append(input) {
      const row = nextSeq.get({ session_id: input.sessionId }) as { n: number };
      const seq = row.n;
      insert.run({
        session_id: input.sessionId,
        context_segment_id: input.contextSegmentId,
        seq,
        role: input.role,
        content: input.content ?? null,
        tool_call_id: input.toolCallId ?? null,
        tool_calls_json: input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
        metadata_json: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      });
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
