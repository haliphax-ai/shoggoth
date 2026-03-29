import type Database from "better-sqlite3";
import type { Logger } from "../logging";
import {
  claimPendingEvents,
  hasEventProcessingRecord,
  markEventCompleted,
  markEventFailed,
  type EventQueueRow,
} from "./events-queue";

export type HeartbeatHandler = (row: EventQueueRow) => void | Promise<void>;

export interface HeartbeatBatchOptions {
  readonly batchLimit: number;
  readonly concurrency: number;
  readonly handlers: Readonly<Record<string, HeartbeatHandler>>;
  readonly logger?: Logger;
}

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const c = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: c }, () => worker()));
}

/**
 * Heartbeat consumer: claim a batch, dispatch by `eventType` with bounded concurrency.
 * Handlers should treat `row.idempotencyKey` as their idempotency hint when present.
 */
export async function runHeartbeatBatch(
  db: Database.Database,
  options: HeartbeatBatchOptions,
): Promise<number> {
  const batch = claimPendingEvents(db, { limit: options.batchLimit });
  if (batch.length === 0) return 0;

  const log = options.logger;

  const processOne = async (row: EventQueueRow) => {
    if (hasEventProcessingRecord(db, row.id)) {
      markEventCompleted(db, row.id);
      return;
    }
    const handler = options.handlers[row.eventType];
    if (!handler) {
      markEventFailed(db, row.id, `no_handler:${row.eventType}`);
      return;
    }
    try {
      await handler(row);
      markEventCompleted(db, row.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markEventFailed(db, row.id, msg);
      log?.warn("event handler failed", {
        eventId: row.id,
        eventType: row.eventType,
        err: msg,
      });
    }
  };

  await runPool(batch, options.concurrency, processOne);
  return batch.length;
}

export function createDefaultHeartbeatHandlers(ctx: {
  readonly logger?: Logger;
}): Record<string, HeartbeatHandler> {
  return {
    "cron.fire": (row) => {
      ctx.logger?.debug("cron.fire consumed", {
        eventId: row.id,
        scope: row.scope,
        idempotencyKey: row.idempotencyKey,
      });
    },
  };
}
