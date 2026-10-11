import type Database from "better-sqlite3";

// TODO: total_cost — requires per-model pricing tables

interface SessionStats {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cumulative prompt tokens served from the provider's prompt cache (cache reads). */
  readonly cachedInputTokens: number;
  /** Cumulative prompt tokens written to the provider's prompt cache. */
  readonly cacheWriteInputTokens: number;
  readonly contextWindowTokens: number | null;
  /** Total input+output tokens of the most recent provider-reported model
   *  call (gauge, not cumulative); null until provider usage is recorded. */
  readonly contextFillTokens: number | null;
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
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  context_window_tokens: number | null;
  context_fill_tokens: number | null;
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
    cachedInputTokens: r.cached_input_tokens,
    cacheWriteInputTokens: r.cache_write_input_tokens,
    contextWindowTokens: r.context_window_tokens,
    contextFillTokens: r.context_fill_tokens,
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
              cached_input_tokens, cache_write_input_tokens, context_window_tokens,
              context_fill_tokens, first_turn_at, last_turn_at, last_compacted_at,
              transcript_message_count, updated_at
       FROM session_stats WHERE session_id = @sessionId`,
    )
    .get({ sessionId }) as SessionStatsRow | undefined;
  return row ? rowToStats(row) : null;
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
       -- compaction replaced the live context; the provider-reported gauge is
       -- stale until the next model call re-establishes it
       context_fill_tokens = NULL,
       updated_at = datetime('now')`,
  ).run({
    sessionId,
    transcriptMessageCount: input.transcriptMessageCount,
  });
}

/** Reset per-segment counters (turn_count, compaction_count, input_tokens, output_tokens, transcript_message_count). Called on context new/reset. */
export function resetSegmentStats(db: Database.Database, sessionId: string): void {
  db.prepare(
    `UPDATE session_stats SET
       turn_count = 0,
       compaction_count = 0,
       input_tokens = 0,
       output_tokens = 0,
       cached_input_tokens = 0,
       cache_write_input_tokens = 0,
       transcript_message_count = 0,
       last_compacted_at = NULL,
       context_fill_tokens = NULL,
       updated_at = datetime('now')
     WHERE session_id = @sessionId`,
  ).run({ sessionId });
}

/** Approximate token count: ~4 chars per token (cl100k_base heuristic). */
export function estimateTokens(text: string | null): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

const JSON_STRUCTURAL = new Set(["{", "}", "[", "]", ",", ":", '"']);

/** Estimate tokens using per-character classification: JSON structural chars at 2 chars/token, everything else at 4 chars/token. */
export function estimateTokensFromContent(text: string): number {
  let structural = 0;
  for (let i = 0; i < text.length; i++) {
    if (JSON_STRUCTURAL.has(text[i])) structural++;
  }
  return structural / 2 + (text.length - structural) / 4;
}

/**
 * Estimate current context fill for a session by summing estimated tokens
 * across all transcript messages in the current context segment.
 */
export function estimateCurrentContextFill(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): number {
  const rows = db
    .prepare(
      `SELECT content FROM transcript_messages
       WHERE session_id = @sessionId AND context_segment_id = @ctxSeg`,
    )
    .all({ sessionId, ctxSeg: contextSegmentId }) as {
    content: string | null;
  }[];
  let total = 0;
  for (const r of rows) {
    total += estimateTokens(r.content);
  }
  return total;
}

interface FormattedSessionStats {
  readonly contextFill: string;
  readonly contextWindowSuffix: string;
  readonly turns: number;
  readonly compactions: number;
  readonly messages: number;
}

/**
 * Build a normalized stats summary usable by both the system prompt and /status.
 */
export function buildFormattedStats(
  stats: SessionStats,
  contextFillTokens: number,
): FormattedSessionStats {
  const contextFill =
    contextFillTokens > 0 ? `~${contextFillTokens.toLocaleString("en-US")}` : "N/A";

  let contextWindowSuffix = "";
  if (stats.contextWindowTokens != null && contextFillTokens > 0) {
    const pct = ((contextFillTokens / stats.contextWindowTokens) * 100).toFixed(1);
    contextWindowSuffix = ` / ${stats.contextWindowTokens.toLocaleString("en-US")} (${pct}%)`;
  }

  return {
    contextFill,
    contextWindowSuffix,
    turns: stats.turnCount,
    compactions: stats.compactionCount,
    messages: stats.transcriptMessageCount,
  };
}

/**
 * Increment cumulative input/output token totals (and optionally the
 * provider-reported cache split and context_window_tokens) without touching
 * turn_count. When `contextFillTokens` is provided (provider-reported total
 * input+output of the most recent call) it replaces the context-fill gauge;
 * heuristic estimates must NOT pass it.
 */
export function incrementTokenUsage(
  db: Database.Database,
  sessionId: string,
  input: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    contextWindowTokens?: number;
    /** Provider-reported context fill gauge (last call's total input+output). */
    contextFillTokens?: number;
  },
): void {
  db.prepare(
    `INSERT INTO session_stats (
       session_id, input_tokens, output_tokens, cached_input_tokens,
       cache_write_input_tokens, context_window_tokens, context_fill_tokens, updated_at
     ) VALUES (
       @sessionId, @inputTokens, @outputTokens, @cachedInputTokens,
       @cacheWriteInputTokens, @contextWindowTokens, @contextFillTokens, datetime('now')
     )
     ON CONFLICT(session_id) DO UPDATE SET
       input_tokens = input_tokens + @inputTokens,
       output_tokens = output_tokens + @outputTokens,
       cached_input_tokens = cached_input_tokens + @cachedInputTokens,
       cache_write_input_tokens = cache_write_input_tokens + @cacheWriteInputTokens,
       context_window_tokens = COALESCE(@contextWindowTokens, context_window_tokens),
       context_fill_tokens = COALESCE(@contextFillTokens, context_fill_tokens),
       updated_at = datetime('now')`,
  ).run({
    sessionId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
    contextWindowTokens: input.contextWindowTokens ?? null,
    contextFillTokens: input.contextFillTokens ?? null,
  });
}

/**
 * Current context fill in tokens. Prefers the provider-reported gauge (total
 * input+output of the most recent model call in the current segment, which
 * includes system prompt and tool schema overhead the transcript heuristic
 * cannot see) and falls back to the transcript character heuristic when the
 * provider has reported no usage yet.
 */
export function getContextFill(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
): number {
  const row = db
    .prepare(`SELECT context_fill_tokens FROM session_stats WHERE session_id = @sessionId`)
    .get({ sessionId }) as { context_fill_tokens: number | null } | undefined;
  const gauge = row?.context_fill_tokens;
  if (typeof gauge === "number" && gauge > 0) return gauge;
  return estimateCurrentContextFill(db, sessionId, contextSegmentId);
}

/** Set transcript_message_count to an absolute value. */
export function updateTranscriptMessageCount(
  db: Database.Database,
  sessionId: string,
  count: number,
): void {
  db.prepare(
    `INSERT INTO session_stats (session_id, transcript_message_count, updated_at)
     VALUES (@sessionId, @count, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       transcript_message_count = @count,
       updated_at = datetime('now')`,
  ).run({ sessionId, count });
}

/** Increment turn_count by 1 and set last_turn_at. */
export function incrementTurnCount(db: Database.Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO session_stats (session_id, turn_count, first_turn_at, last_turn_at, updated_at)
     VALUES (@sessionId, 1, datetime('now'), datetime('now'), datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       turn_count = turn_count + 1,
       first_turn_at = COALESCE(first_turn_at, datetime('now')),
       last_turn_at = datetime('now'),
       updated_at = datetime('now')`,
  ).run({ sessionId });
}
