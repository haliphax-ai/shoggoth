import type Database from "better-sqlite3";

export const EVENT_SCOPE_GLOBAL = "global";

export function sessionEventScope(sessionId: string): string {
  return `session:${sessionId}`;
}

export type EventStatus = "pending" | "processing" | "completed" | "dead";

export interface EventQueueRow {
  readonly id: number;
  readonly scope: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly idempotencyKey: string | null;
  readonly status: EventStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

export type EmitResult =
  | { ok: true; id: number }
  | { ok: false; duplicate: true; existingId: number };

function isSqliteConstraint(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function backoffSecondsAfterFailure(attemptsAfterIncrement: number): number {
  const base = 2;
  const cap = 3600;
  return Math.min(cap, base ** Math.min(attemptsAfterIncrement, 20));
}

/**
 * Durable emit (global or session-scoped `scope` string).
 */
export function emitEvent(
  db: Database.Database,
  input: {
    readonly scope: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
  },
): EmitResult {
  const payloadJson = JSON.stringify(input.payload);
  const maxAttempts = input.maxAttempts ?? 8;
  try {
    const r = db
      .prepare(
        `
      INSERT INTO events (
        scope, event_type, payload_json, idempotency_key, status, attempts,
        max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        @scope, @event_type, @payload_json, @idempotency_key, 'pending', 0,
        @max_attempts, datetime('now'), datetime('now'), datetime('now')
      )
    `,
      )
      .run({
        scope: input.scope,
        event_type: input.eventType,
        payload_json: payloadJson,
        idempotency_key: input.idempotencyKey ?? null,
        max_attempts: maxAttempts,
      });
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (isSqliteConstraint(e) && input.idempotencyKey) {
      const row = db
        .prepare("SELECT id FROM events WHERE idempotency_key = @k")
        .get({ k: input.idempotencyKey }) as { id: number } | undefined;
      if (row) return { ok: false, duplicate: true, existingId: row.id };
    }
    throw e;
  }
}

function mapRow(r: {
  id: number;
  scope: string;
  event_type: string;
  payload_json: string;
  idempotency_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}): EventQueueRow {
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload_json) as unknown;
  } catch {
    payload = undefined;
  }
  return {
    id: r.id,
    scope: r.scope,
    eventType: r.event_type,
    payload,
    idempotencyKey: r.idempotency_key,
    status: r.status as EventStatus,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
  };
}

/**
 * Claims up to `limit` pending events (ready by next_attempt_at), ordered FIFO.
 */
export function claimPendingEvents(db: Database.Database, options: { limit: number }): EventQueueRow[] {
  const tx = db.transaction(() => {
    const ids = db
      .prepare(
        `
      SELECT id FROM events
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY id ASC
      LIMIT @limit
    `,
      )
      .all({ limit: options.limit }) as { id: number }[];

    for (const { id } of ids) {
      db.prepare(
        `
        UPDATE events SET
          status = 'processing',
          claimed_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = @id
      `,
      ).run({ id });
    }
    return ids.map((x) => x.id);
  });

  const idList = tx();
  if (idList.length === 0) return [];

  const placeholders = idList.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
    SELECT id, scope, event_type, payload_json, idempotency_key, status, attempts,
           max_attempts, next_attempt_at, last_error
    FROM events WHERE id IN (${placeholders})
    ORDER BY id ASC
  `,
    )
    .all(...idList) as Parameters<typeof mapRow>[0][];

  return rows.map(mapRow);
}

/** True if this event id was already finished (at-least-once consumer idempotency). */
export function hasEventProcessingRecord(db: Database.Database, eventId: number): boolean {
  const r = db
    .prepare("SELECT 1 AS x FROM event_processing_done WHERE event_id = @id")
    .get({ id: eventId }) as { x: number } | undefined;
  return r !== undefined;
}

export function markEventCompleted(db: Database.Database, eventId: number): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO event_processing_done (event_id, finished_at)
    VALUES (@id, datetime('now'))
  `,
  ).run({ id: eventId });
  db.prepare(
    `
    UPDATE events SET status = 'completed', updated_at = datetime('now'), claimed_at = NULL
    WHERE id = @id
  `,
  ).run({ id: eventId });
}

export function markEventFailed(db: Database.Database, eventId: number, errorMessage: string): void {
  const row = db
    .prepare(
      `
    SELECT attempts, max_attempts FROM events WHERE id = @id
  `,
  )
    .get({ id: eventId }) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return;

  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= row.max_attempts) {
    db.prepare(
      `
      UPDATE events SET
        status = 'dead',
        attempts = @attempts,
        last_error = @err,
        updated_at = datetime('now'),
        claimed_at = NULL,
        next_attempt_at = NULL
      WHERE id = @id
    `,
    ).run({ id: eventId, attempts: nextAttempts, err: errorMessage });
    return;
  }

  const delaySec = backoffSecondsAfterFailure(nextAttempts);
  db.prepare(
    `
    UPDATE events SET
      status = 'pending',
      attempts = @attempts,
      last_error = @err,
      next_attempt_at = datetime('now', printf('+%d seconds', @delay)),
      updated_at = datetime('now'),
      claimed_at = NULL
    WHERE id = @id
  `,
  ).run({ id: eventId, attempts: nextAttempts, err: errorMessage, delay: delaySec });
}

/**
 * Heartbeat/restart safety: pending-ize events stuck in `processing` with an old claim.
 */
export function reconcileStaleProcessing(db: Database.Database, options: { staleMs: number }): number {
  const sec = Math.max(1, Math.floor(options.staleMs / 1000));
  const r = db
    .prepare(
      `
    UPDATE events SET
      status = 'pending',
      claimed_at = NULL,
      updated_at = datetime('now')
    WHERE status = 'processing'
      AND claimed_at IS NOT NULL
      AND datetime(claimed_at) < datetime('now', printf('-%d seconds', @sec))
  `,
  )
    .run({ sec });
  return r.changes;
}
