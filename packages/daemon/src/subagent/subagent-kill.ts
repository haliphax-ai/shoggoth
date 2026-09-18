import type { SessionManager } from "../sessions/session-manager";
import { requestSessionTurnAbort } from "../sessions/session-turn-abort";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import { disposeSubagentRuntime } from "./subagent-disposables";
import {
  subagentRuntimeExtensionRef,
  type PersistentSubagentSessionEndReason,
} from "./subagent-extension-ref";

/**
 * Aborts any in-flight tool loop, clears in-process bindings, then terminates the session
 * (tokens revoked, status terminated).
 * For persistent subagents with a thread binding, pass `endReason` so the messaging layer can announce in-thread first.
 * When `autoApproveGate` is provided, cleans up the session's auto-approve entries to prevent unbounded Map growth.
 */
export function terminatePersistentSubagentSession(
  sessionManager: SessionManager,
  sessionId: string,
  endReason?: PersistentSubagentSessionEndReason,
  autoApproveGate?: HitlAutoApproveGate,
): void {
  const sid = sessionId.trim();
  const ext = subagentRuntimeExtensionRef.current;
  if (endReason && ext?.announcePersistentSubagentSessionEnded) {
    try {
      ext.announcePersistentSubagentSessionEnded({
        sessionId: sid,
        reason: endReason,
      });
    } catch {
      /* best-effort notice */
    }
  }
  // Abort the in-flight tool/model loop so the subagent doesn't keep running.
  requestSessionTurnAbort(sid);
  disposeSubagentRuntime(sid);
  sessionManager.kill(sid);
  // Prune in-memory auto-approve entries for the terminated session.
  autoApproveGate?.clearSession(sid);
}
