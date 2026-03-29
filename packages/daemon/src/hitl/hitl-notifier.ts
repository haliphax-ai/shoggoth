import type { PendingActionRow } from "./pending-actions-store";

/** Pluggable operator alert when a HITL row is queued (Discord webhook, Slack, etc.). */
export interface HitlNotifier {
  onQueued(row: PendingActionRow): void;
}
