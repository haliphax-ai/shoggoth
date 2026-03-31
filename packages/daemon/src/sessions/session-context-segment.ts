import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { clearSessionToolAutoApproveForSession } from "../hitl/hitl-session-tool-auto-store";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import type { SessionStore } from "./session-store";
import { resetSegmentStats } from "./session-stats-store";
import { createTranscriptStore } from "./transcript-store";

function denyPendingForSession(pending: PendingActionsStore | undefined, sessionId: string): void {
  if (!pending) return;
  for (const row of pending.listPendingForSession(sessionId)) {
    pending.deny(row.id, "session:context_segment");
  }
}

/**
 * Transport-agnostic session context segments (`sessions.context_segment_id`). Callers: control-plane
 * ops (`session_context_new` / `session_context_reset`), messaging adapters, future CLI.
 *
 * **New** clears the current segment’s transcript, mints a new segment id, denies pending HITL for the
 * session, and clears **per-session** tool auto-approve (`hitl_session_tool_auto_approve`, e.g. Discord ✅
 * “this tool for session”). Older transcript rows for prior segments remain in SQLite but are excluded
 * from the model context. **Reset** clears the transcript for the current segment only (id unchanged) and
 * **retains** per-session auto-approvals.
 */
export function applySessionContextSegmentNew(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
}): { previousContextSegmentId: string; contextSegmentId: string; deletedRows: number } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const previousContextSegmentId = row.contextSegmentId.trim();
  if (!previousContextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  clearSessionToolAutoApproveForSession(input.db, sessionId);
  const tr = createTranscriptStore(input.db);
  const deletedRows = tr.deleteForSessionSegment(sessionId, previousContextSegmentId);
  const contextSegmentId = randomUUID();
  input.sessions.update(sessionId, { contextSegmentId });
  resetSegmentStats(input.db, sessionId);
  return { previousContextSegmentId, contextSegmentId, deletedRows };
}

export function applySessionContextSegmentReset(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
}): { contextSegmentId: string; deletedRows: number } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const contextSegmentId = row.contextSegmentId.trim();
  if (!contextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  const tr = createTranscriptStore(input.db);
  const deletedRows = tr.deleteForSessionSegment(sessionId, contextSegmentId);
  resetSegmentStats(input.db, sessionId);
  return { contextSegmentId, deletedRows };
}
