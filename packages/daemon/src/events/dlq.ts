import type Database from "better-sqlite3";

export interface DeadLetterEventRow {
  readonly id: number;
  readonly scope: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** Operator visibility for poison / exhausted-retry events (`status = dead`). */
export function listDeadLetterEvents(
  db: Database.Database,
  options: { limit: number },
): DeadLetterEventRow[] {
  const rows = db
    .prepare(
      `
    SELECT id, scope, event_type, payload_json, attempts, max_attempts, last_error, created_at
    FROM events
    WHERE status = 'dead'
    ORDER BY id DESC
    LIMIT @limit
  `,
    )
    .all({ limit: options.limit }) as Array<{
      id: number;
      scope: string;
      event_type: string;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: string;
    }>;

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    eventType: r.event_type,
    payload: safeJson(r.payload_json),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
  }));
}
