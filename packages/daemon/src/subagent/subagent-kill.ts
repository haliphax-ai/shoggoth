import type { SessionManager } from "../sessions/session-manager";
import { disposeSubagentRuntime } from "./subagent-disposables";
import { subagentRuntimeExtensionRef, type PersistentSubagentSessionEndReason } from "./subagent-extension-ref";

export type { PersistentSubagentSessionEndReason };

/**
 * Clears in-process bindings then terminates the session (tokens revoked, status terminated).
 * For persistent subagents with a thread binding, pass `endReason` so the messaging layer can announce in-thread first.
 */
export function terminatePersistentSubagentSession(
  sessionManager: SessionManager,
  sessionId: string,
  endReason?: PersistentSubagentSessionEndReason,
): void {
  const sid = sessionId.trim();
  const ext = subagentRuntimeExtensionRef.current;
  if (endReason && ext?.announcePersistentSubagentSessionEnded) {
    try {
      ext.announcePersistentSubagentSessionEnded({ sessionId: sid, reason: endReason });
    } catch {
      /* best-effort notice */
    }
  }
  disposeSubagentRuntime(sid);
  sessionManager.kill(sid);
}
