import type Database from "better-sqlite3";

// TODO: total_cost — requires per-model pricing tables

export interface SessionStats {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindowTokens: number | null;
  readonly firstTurnAt: string | null;
  readonly lastTurnAt: string | null;
  readonly lastCompactedAt: string | null;
  readonly transcriptMessageCount: number;
  readonly updatedAt: string;
}

interface SessionStatsRow {
  session_id: string;
  turn_count: number;
  compaction_count: number;
  input_tokens: number;
  output_tokens: number;
  context_window_tokens: number | null;
  first_turn_at: string | null;
  last_turn_at: string | null;
  last_compacted_at: string | null;
  transcript_message_count: number;
  updated_at: string;
}

function rowToStats(r: SessionStatsRow): SessionStats {
  return {
    sessionId: r.session_id,
    turnCount: r.turn_count,
    compactionCount: r.compaction_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    contextWindowTokens: r.context_window_tokens,
    firstTurnAt: r.first_turn_at,
    lastTurnAt: r.last_turn_at,
    lastCompactedAt: r.last_compacted_at,
    transcriptMessageCount: r.transcript_message_count,
    updatedAt: r.updated_at,
  };
}

/** Get stats for a session. Returns null if no stats row exists yet. */
export function getSessionStats(db: Database.Database, sessionId: string): SessionStats | null {
  const row = db
    .prepare(
      `SELECT session_id, turn_count, compaction_count, input_tokens, output_tokens,
              context_window_tokens, first_turn_at, last_turn_at, last_compacted_at,
              transcript_message_count, updated_at
       FROM session_stats WHERE session_id = @sessionId`,
    )
    .get({ sessionId }) as SessionStatsRow | undefined;
  return row ? rowToStats(row) : null;
}

/** Record a completed agent turn. Upserts the row, incrementing turn_count and adding token usage. */
export function recordAgentTurn(
  db: Database.Database,
  sessionId: string,
  input: {
    inputTokens: number;
    outputTokens: number;
    contextWindowTokens?: number;
    transcriptMessageCount: number;
  },
): void {
  db.prepare(
    `INSERT INTO session_stats (
       session_id, turn_count, input_tokens, output_tokens,
       context_window_tokens, first_turn_at, last_turn_at,
       transcript_message_count, updated_at
     ) VALUES (
       @sessionId, 1, @inputTokens, @outputTokens,
       @contextWindowTokens, datetime('now'), datetime('now'),
       @transcriptMessageCount, datetime('now')
     )
     ON CONFLICT(session_id) DO UPDATE SET
       turn_count = turn_count + 1,
       input_tokens = input_tokens + @inputTokens,
       output_tokens = output_tokens + @outputTokens,
       context_window_tokens = COALESCE(@contextWindowTokens, context_window_tokens),
       first_turn_at = COALESCE(first_turn_at, datetime('now')),
       last_turn_at = datetime('now'),
       transcript_message_count = @transcriptMessageCount,
       updated_at = datetime('now')`,
  ).run({
    sessionId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    contextWindowTokens: input.contextWindowTokens ?? null,
    transcriptMessageCount: input.transcriptMessageCount,
  });
}

/** Record a completed compaction. Increments compaction_count and updates transcript_message_count. */
export function recordCompaction(
  db: Database.Database,
  sessionId: string,
  input: {
    transcriptMessageCount: number;
  },
): void {
  db.prepare(
    `INSERT INTO session_stats (
       session_id, compaction_count, last_compacted_at,
       transcript_message_count, updated_at
     ) VALUES (
       @sessionId, 1, datetime('now'),
       @transcriptMessageCount, datetime('now')
     )
     ON CONFLICT(session_id) DO UPDATE SET
       compaction_count = compaction_count + 1,
       last_compacted_at = datetime('now'),
       transcript_message_count = @transcriptMessageCount,
       updated_at = datetime('now')`,
  ).run({
    sessionId,
    transcriptMessageCount: input.transcriptMessageCount,
  });
}

/** Reset per-segment counters (turn_count, input_tokens, output_tokens, transcript_message_count). Called on context new/reset. */
export function resetSegmentStats(db: Database.Database, sessionId: string): void {
  db.prepare(
    `UPDATE session_stats SET
       turn_count = 0,
       input_tokens = 0,
       output_tokens = 0,
       transcript_message_count = 0,
       updated_at = datetime('now')
     WHERE session_id = @sessionId`,
  ).run({ sessionId });
}

/** Update context_window_tokens for a session. */
export function setContextWindowTokens(
  db: Database.Database,
  sessionId: string,
  tokens: number,
): void {
  db.prepare(
    `INSERT INTO session_stats (session_id, context_window_tokens, updated_at)
     VALUES (@sessionId, @tokens, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       context_window_tokens = @tokens,
       updated_at = datetime('now')`,
  ).run({ sessionId, tokens });
}
