import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { generateSystemContextToken } from "@shoggoth/shared";
import { clearSessionToolAutoApproveForSession } from "../hitl/hitl-session-tool-auto-store";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import type { SessionStore } from "./session-store";
import { resetSegmentStats } from "./session-stats-store";

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
 * Neither operation deletes transcript rows — old messages are abandoned (excluded from model context
 * by the new segment id) and left for the retention workflow to clean up.
 *
 * **New** mints a new segment id, denies pending HITL for the session, clears **per-session** tool
 * auto-approve (`hitl_session_tool_auto_approve`, e.g. ✅ "this tool for session"), and kills
 * all subagents for the session (via the optional `killSubagents` callback).
 *
 * **Reset** mints a new segment id and denies pending HITL. Retains per-session auto-approvals and
 * does not touch subagents.
 */
export function applySessionContextSegmentNew(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
  /** Called with child session ids to terminate; caller wires subagent kill logic. */
  readonly killSubagents?: (childSessionIds: string[]) => void;
}): { previousContextSegmentId: string; contextSegmentId: string } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const previousContextSegmentId = row.contextSegmentId.trim();
  if (!previousContextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  clearSessionToolAutoApproveForSession(input.db, sessionId);
  const contextSegmentId = randomUUID();
  input.sessions.update(sessionId, { contextSegmentId, systemContextToken: generateSystemContextToken() });
  resetSegmentStats(input.db, sessionId);
  if (input.killSubagents) {
    const children = input.sessions
      .list({ parentSessionId: sessionId })
      .filter((c) => c.status !== "terminated")
      .map((c) => c.id);
    if (children.length > 0) input.killSubagents(children);
  }
  return { previousContextSegmentId, contextSegmentId };
}

export function applySessionContextSegmentReset(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
}): { previousContextSegmentId: string; contextSegmentId: string } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const previousContextSegmentId = row.contextSegmentId.trim();
  if (!previousContextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  const contextSegmentId = randomUUID();
  input.sessions.update(sessionId, { contextSegmentId, systemContextToken: generateSystemContextToken() });
  resetSegmentStats(input.db, sessionId);
  return { previousContextSegmentId, contextSegmentId };
}
