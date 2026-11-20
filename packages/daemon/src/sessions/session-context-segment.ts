import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { generateSystemContextToken } from "@shoggoth/shared";
import { clearSessionToolAutoApproveForSession } from "../hitl/hitl-session-tool-auto-store";
import type { PendingActionsStore } from "../hitl/pending-actions-store";
import type { SessionStore } from "./session-store";
import { resetSegmentStats } from "./session-stats-store";
import { pushSystemContext } from "./system-context-buffer";
import { clearSessionReReadRequired } from "./re-read-required";
import { clearSessionToolState } from "./session-tool-discovery";
import { createTranscriptStore } from "./transcript-store";

function denyPendingForSession(pending: PendingActionsStore | undefined, sessionId: string): void {
  if (!pending) return;
  for (const row of pending.listPendingForSession(sessionId)) {
    pending.deny(row.id, "session:context_segment");
  }
}

/**
 * Still-running, killable subagent children of `sessionId`. **Persistent** subagents
 * (`subagentMode === "persistent"`) are excluded — a context segment change never tears them down.
 */
function killableSubagentChildIds(sessions: SessionStore, sessionId: string): string[] {
  return sessions
    .list({ parentSessionId: sessionId })
    .filter((c) => c.status !== "terminated" && c.subagentMode !== "persistent")
    .map((c) => c.id);
}

/**
 * Transport-agnostic session context segments (`sessions.context_segment_id`)
 * for control-plane ops, messaging adapters, and the future CLI. **New** mints
 * a segment id; **Reset** wipes the current segment's transcript rows and keeps
 * the segment id. Both kill one-shot subagents; persistent subagents survive.
 * Full semantics: docs/daemon.md → "Context Segments".
 */
export function applySessionContextSegmentNew(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
  /** Called with the session's killable (non-persistent) subagent child ids; caller wires the kill. */
  readonly killSubagents?: (childSessionIds: string[]) => void;
}): { previousContextSegmentId: string; contextSegmentId: string } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const previousContextSegmentId = row.contextSegmentId.trim();
  if (!previousContextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  clearSessionToolAutoApproveForSession(input.db, sessionId);
  clearSessionReReadRequired(input.db, sessionId);
  clearSessionToolState(input.db, sessionId);
  const contextSegmentId = randomUUID();
  input.sessions.update(sessionId, {
    contextSegmentId,
    systemContextToken: generateSystemContextToken(),
  });
  resetSegmentStats(input.db, sessionId);
  if (input.killSubagents) {
    const children = killableSubagentChildIds(input.sessions, sessionId);
    if (children.length > 0) input.killSubagents(children);
  }
  pushSystemContext(sessionId, "Fresh session. No prior conversation history.");
  return { previousContextSegmentId, contextSegmentId };
}

export function applySessionContextSegmentReset(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly pending?: PendingActionsStore;
  /** Called with the session's killable (non-persistent) subagent child ids; caller wires the kill. */
  readonly killSubagents?: (childSessionIds: string[]) => void;
}): { previousContextSegmentId: string; contextSegmentId: string } {
  const sessionId = input.sessionId.trim();
  const row = input.sessions.getById(sessionId);
  if (!row) throw new Error(`session not found: ${input.sessionId}`);
  const previousContextSegmentId = row.contextSegmentId.trim();
  if (!previousContextSegmentId) throw new Error("session missing context_segment_id");
  denyPendingForSession(input.pending, sessionId);
  clearSessionReReadRequired(input.db, sessionId);
  clearSessionToolState(input.db, sessionId);
  // Reset keeps the current segment: the transcript is wiped in place (deleted, not
  // abandoned) so the session continues with the segment id it already had.
  createTranscriptStore(input.db).deleteForSessionSegment(sessionId, previousContextSegmentId);
  input.sessions.update(sessionId, {
    systemContextToken: generateSystemContextToken(),
  });
  resetSegmentStats(input.db, sessionId);
  if (input.killSubagents) {
    const children = killableSubagentChildIds(input.sessions, sessionId);
    if (children.length > 0) input.killSubagents(children);
  }
  pushSystemContext(sessionId, "Fresh session. No prior conversation history.");
  return { previousContextSegmentId, contextSegmentId: previousContextSegmentId };
}
