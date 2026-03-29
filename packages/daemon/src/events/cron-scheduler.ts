import type Database from "better-sqlite3";
import { emitEvent, EVENT_SCOPE_GLOBAL, sessionEventScope } from "./events-queue";

/** Parses `every:Ns` (e.g. `every:60s`) into seconds; returns null if unsupported. */
export function parseEverySchedule(scheduleExpr: string): number | null {
  const m = /^every:(\d+)s$/i.exec(scheduleExpr.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export interface UpsertCronJobInput {
  readonly id: string;
  readonly scheduleExpr: string;
  readonly payload?: unknown;
  readonly enabled?: boolean;
  readonly sessionId?: string | null;
}

export function upsertCronJob(db: Database.Database, input: UpsertCronJobInput): void {
  const payloadJson =
    input.payload !== undefined && input.payload !== null ? JSON.stringify(input.payload) : null;
  const enabled = input.enabled !== false ? 1 : 0;
  db.prepare(
    `
    INSERT INTO cron_jobs (
      id, schedule_expr, payload_json, enabled, session_id,
      next_run_at, created_at, updated_at
    ) VALUES (
      @id, @schedule_expr, @payload_json, @enabled, @session_id,
      datetime('now'), datetime('now'), datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      schedule_expr = excluded.schedule_expr,
      payload_json = excluded.payload_json,
      enabled = excluded.enabled,
      session_id = excluded.session_id,
      next_run_at = datetime('now'),
      updated_at = datetime('now')
  `,
  ).run({
    id: input.id,
    schedule_expr: input.scheduleExpr,
    payload_json: payloadJson,
    enabled,
    session_id: input.sessionId ?? null,
  });
}

export interface CronJobRow {
  readonly id: string;
  readonly schedule_expr: string;
  readonly payload_json: string | null;
  readonly enabled: number;
  readonly session_id: string | null;
  readonly next_run_at: string | null;
}

/**
 * Fires due cron jobs once each (catch-up: single fire even if multiple periods were missed).
 * Enqueues `cron.fire` events and updates `last_run_at` / `next_run_at` / `last_status`.
 */
export function runCronTick(db: Database.Database): number {
  const jobs = db
    .prepare(
      `
    SELECT id, schedule_expr, payload_json, enabled, session_id, next_run_at
    FROM cron_jobs
    WHERE enabled = 1
      AND (next_run_at IS NULL OR next_run_at <= datetime('now'))
  `,
    )
    .all() as CronJobRow[];

  let fired = 0;
  for (const job of jobs) {
    const intervalSec = parseEverySchedule(job.schedule_expr);
    if (intervalSec === null) {
      db.prepare(
        `
        UPDATE cron_jobs SET
          last_status = 'error',
          last_error = @err,
          updated_at = datetime('now')
        WHERE id = @id
      `,
      ).run({ id: job.id, err: `unsupported schedule_expr: ${job.schedule_expr}` });
      continue;
    }

    let userPayload: unknown = {};
    if (job.payload_json) {
      try {
        userPayload = JSON.parse(job.payload_json) as unknown;
      } catch {
        userPayload = {};
      }
    }

    const envelope = { cronJobId: job.id, payload: userPayload };
    const scope = job.session_id ? sessionEventScope(job.session_id) : EVENT_SCOPE_GLOBAL;
    emitEvent(db, {
      scope,
      eventType: "cron.fire",
      payload: envelope,
    });

    db.prepare(
      `
      UPDATE cron_jobs SET
        last_run_at = datetime('now'),
        next_run_at = datetime('now', printf('+%d seconds', @sec)),
        last_status = 'ok',
        last_error = NULL,
        updated_at = datetime('now')
      WHERE id = @id
    `,
    ).run({ id: job.id, sec: intervalSec });
    fired += 1;
  }
  return fired;
}
