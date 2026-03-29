import type Database from "better-sqlite3";
import { createToolRunStore } from "../sessions/tool-run-store";
import { reconcileStaleProcessing } from "./events-queue";

export interface BootReconciliationResult {
  readonly staleEventsRequeued: number;
  readonly toolRunsMarkedFailed: number;
}

/**
 * After restart, release stale processing claims and mark orphaned tool runs failed.
 */
export function runBootReconciliation(
  db: Database.Database,
  options: {
    readonly staleClaimMs: number;
    readonly orphanedToolRunReason: string;
  },
): BootReconciliationResult {
  const staleEventsRequeued = reconcileStaleProcessing(db, { staleMs: options.staleClaimMs });
  const toolRunsMarkedFailed = createToolRunStore(db).markAllRunningFailed(
    options.orphanedToolRunReason,
  );
  return { staleEventsRequeued, toolRunsMarkedFailed };
}
