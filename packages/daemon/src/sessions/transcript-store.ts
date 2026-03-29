import type Database from "better-sqlite3";

export interface TranscriptMessageRow {
  readonly seq: number;
  readonly role: string;
  readonly content: string | null;
  readonly toolCallId: string | null;
  readonly metadata?: unknown;
}

export interface AppendTranscriptInput {
  readonly sessionId: string;
  readonly role: string;
  readonly content?: string | null;
  readonly toolCallId?: string | null;
  readonly metadata?: unknown;
}

export interface TranscriptStore {
  append(input: AppendTranscriptInput): { seq: number };
  listPage(input: {
    sessionId: string;
    afterSeq: number;
    limit: number;
  }): { messages: TranscriptMessageRow[]; nextCursor: number | undefined };
}

export function createTranscriptStore(db: Database.Database): TranscriptStore {
  const nextSeq = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM transcript_messages WHERE session_id = @session_id
  `);

  const insert = db.prepare(`
    INSERT INTO transcript_messages (session_id, seq, role, content, tool_call_id, metadata_json)
    VALUES (@session_id, @seq, @role, @content, @tool_call_id, @metadata_json)
  `);

  const selectPage = db.prepare(`
    SELECT seq, role, content, tool_call_id, metadata_json
    FROM transcript_messages
    WHERE session_id = @session_id AND seq > @after_seq
    ORDER BY seq ASC
    LIMIT @limit
  `);

  return {
    append(input) {
      const row = nextSeq.get({ session_id: input.sessionId }) as { n: number };
      const seq = row.n;
      insert.run({
        session_id: input.sessionId,
        seq,
        role: input.role,
        content: input.content ?? null,
        tool_call_id: input.toolCallId ?? null,
        metadata_json: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      });
      return { seq };
    },

    listPage({ sessionId, afterSeq, limit }) {
      const rows = selectPage.all({
        session_id: sessionId,
        after_seq: afterSeq,
        limit,
      }) as {
        seq: number;
        role: string;
        content: string | null;
        tool_call_id: string | null;
        metadata_json: string | null;
      }[];

      const messages: TranscriptMessageRow[] = rows.map((r) => ({
        seq: r.seq,
        role: r.role,
        content: r.content,
        toolCallId: r.tool_call_id,
        metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as unknown) : undefined,
      }));

      const last = messages[messages.length - 1];
      const nextCursor =
        messages.length >= limit && last !== undefined ? last.seq : undefined;

      return { messages, nextCursor };
    },
  };
}
