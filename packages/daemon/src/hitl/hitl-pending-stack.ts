import type Database from "better-sqlite3";
import { createHitlResolutionHub, type HitlResolutionHub } from "./hitl-resolution-hub";
import { createPendingActionsStore, type PendingActionsStore } from "./pending-actions-store";

export type HitlPendingStack = {
  readonly pending: PendingActionsStore;
  readonly hub: HitlResolutionHub;
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
};

/**
 * Single-process HITL: SQLite pending rows + in-memory waiters notified when approve/deny/timeout runs.
 */
export function createHitlPendingResolutionStack(db: Database.Database): HitlPendingStack {
  const hub = createHitlResolutionHub();
  const pending = createPendingActionsStore(db, {
    hooks: {
      onResolved: ({ id, status }) => {
        hub.notifyResolved(id, status === "approved" ? "approved" : "denied");
      },
    },
  });
  return {
    pending,
    hub,
    waitForHitlResolution: (pendingId: string) => hub.waitFor(pendingId),
  };
}
