import type Database from "better-sqlite3";
import {
  compactTranscriptIfNeeded,
  mergeModelInvocationOverlay,
  mergeModelInvocationParams,
  type CompactionPolicy,
  type CompactTranscriptOptions,
  type ChatMessage,
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
      `SELECT role, content, tool_call_id
       FROM transcript_messages
       WHERE session_id = @session_id AND context_segment_id = @context_segment_id
       ORDER BY seq ASC`,
    )
    .all({ session_id: sessionId, context_segment_id: contextSegmentId }) as Array<{
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
  contextSegmentId: string,
  messages: readonly ChatMessage[],
): void {
  const run = db.transaction(() => {
    db
      .prepare(
        `DELETE FROM transcript_messages WHERE session_id = @session_id AND context_segment_id = @context_segment_id`,
      )
      .run({ session_id: sessionId, context_segment_id: contextSegmentId });
    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM transcript_messages WHERE session_id = @session_id`,
      )
      .get({ session_id: sessionId }) as { m: number };
    let seq = maxRow.m + 1;
    const ins = db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content, tool_call_id, metadata_json)
       VALUES (@session_id, @context_segment_id, @seq, @role, @content, @tool_call_id, @metadata_json)`,
    );
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      ins.run({
        session_id: sessionId,
        context_segment_id: contextSegmentId,
        seq,
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId ?? null,
        metadata_json: null,
      });
      seq += 1;
    }
  });
  run();
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
  const result = await compactTranscriptIfNeeded(rows, policy, client, {
    force: options?.force,
    modelInvocation,
  });
  if (result.compacted) {
    replaceSessionTranscript(db, sessionId, contextSegmentId, result.messages);
    recordCompaction(db, sessionId, { transcriptMessageCount: result.messages.length });
  }
  return { compacted: result.compacted, messageCount: result.messages.length };
}
