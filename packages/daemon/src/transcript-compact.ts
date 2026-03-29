import type Database from "better-sqlite3";
import {
  compactTranscriptIfNeeded,
  type CompactionPolicy,
  type CompactTranscriptOptions,
  type ChatMessage,
  type FailoverModelClient,
} from "@shoggoth/models";

export function loadSessionTranscript(
  db: Database.Database,
  sessionId: string,
): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content, tool_call_id
       FROM transcript_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    role: string;
    content: string | null;
    tool_call_id: string | null;
  }>;

  return rows.map((r) => {
    const role = r.role as ChatMessage["role"];
    return {
      role,
      content: r.content ?? "",
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
    };
  });
}

export function replaceSessionTranscript(
  db: Database.Database,
  sessionId: string,
  messages: readonly ChatMessage[],
): void {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM transcript_messages WHERE session_id = ?`).run(sessionId);
    const ins = db.prepare(
      `INSERT INTO transcript_messages (session_id, seq, role, content, tool_call_id, metadata_json)
       VALUES (@session_id, @seq, @role, @content, @tool_call_id, @metadata_json)`,
    );
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      ins.run({
        session_id: sessionId,
        seq: i + 1,
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId ?? null,
        metadata_json: null,
      });
    }
  });
  run();
}

export async function compactSessionTranscript(
  db: Database.Database,
  sessionId: string,
  policy: CompactionPolicy,
  client: FailoverModelClient,
  options?: CompactTranscriptOptions,
): Promise<{ compacted: boolean; messageCount: number }> {
  const rows = loadSessionTranscript(db, sessionId);
  const result = await compactTranscriptIfNeeded(rows, policy, client, options ?? {});
  if (result.compacted) {
    replaceSessionTranscript(db, sessionId, result.messages);
  }
  return { compacted: result.compacted, messageCount: result.messages.length };
}
