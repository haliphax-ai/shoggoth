import type { SessionManager } from "../sessions/session-manager";
import { disposeSubagentRuntime } from "./subagent-disposables";
import { subagentRuntimeExtensionRef, type BoundSubagentSessionEndReason } from "./subagent-extension-ref";

export type { BoundSubagentSessionEndReason };

/**
 * Clears in-process bindings then terminates the session (tokens revoked, status terminated).
 * For bound Discord-thread subagents, pass `endReason` so the messaging layer can announce in-thread first.
 */
export function terminateBoundSubagentSession(
  sessionManager: SessionManager,
  sessionId: string,
  endReason?: BoundSubagentSessionEndReason,
): void {
  const sid = sessionId.trim();
  const ext = subagentRuntimeExtensionRef.current;
  if (endReason && ext?.announceBoundSubagentSessionEnded) {
    try {
      ext.announceBoundSubagentSessionEnded({ sessionId: sid, reason: endReason });
    } catch {
      /* best-effort notice */
    }
  }
  disposeSubagentRuntime(sid);
  sessionManager.kill(sid);
}
