import type { PendingActionRow } from "./pending-actions-store";

/** Pluggable operator alert when a HITL row is queued (webhook, DM, etc.). */
export interface HitlNotifier {
  onQueued(row: PendingActionRow): void;
}
