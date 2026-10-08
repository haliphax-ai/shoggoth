import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { getLogger } from "../logging";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";

const log = getLogger("subagent-reconcile");
import { armPersistentSubagentInactivityTimer } from "./persistent-subagent-timers";
import { rememberSubagentHandles } from "./subagent-disposables";
import type { SubagentRuntimeExtension } from "./subagent-extension-ref";
import { terminatePersistentSubagentSession } from "./subagent-kill";

type ReconcilePersistentSubagentsResult = {
  readonly restored: number;
  readonly expiredKilled: number;
};

/**
 * After a process restart, reattach platform thread routing, A2A bus subscriptions, and TTL timers for
 * persistent subagents that are still persisted in SQLite as active.
 */
export function reconcilePersistentSubagents(input: {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly ext: SubagentRuntimeExtension;
  readonly sessions: SessionStore;
  readonly sessionManager: SessionManager;
}): ReconcilePersistentSubagentsResult {
  const { sessions, sessionManager } = input;

  const candidates = sessions
    .list()
    .filter((s) => s.subagentMode === "persistent" && s.status !== "terminated");

  let restored = 0;
  let expiredKilled = 0;
  const now = Date.now();

  for (const s of candidates) {
    const threadId = s.subagentPlatformThreadId?.trim() || undefined;
    const persistedExpiry = s.subagentExpiresAtMs;
    const validExpiry =
      typeof persistedExpiry === "number" && Number.isFinite(persistedExpiry) && persistedExpiry > 0
        ? persistedExpiry
        : undefined;

    // The persisted inactivity expiry already elapsed while the daemon was down.
    if (validExpiry !== undefined && validExpiry <= now) {
      terminatePersistentSubagentSession(sessionManager, s.id, "ttl_expired");
      expiredKilled++;
      log.info("subagent.reconcile.expired_killed", { sessionId: s.id });
      continue;
    }

    const unregisterThread = threadId
      ? input.ext.registerPlatformThreadBinding(threadId, s.id)
      : () => {};
    const unsubscribeBus = input.ext.subscribeSubagentSession(s.id);
    // Arm the shared inactivity timer: honors the remaining persisted window (restart
    // safety), or defaults to a fresh full inactivity window when the persisted expiry
    // is missing/invalid. The timer persists the expiry again and is re-armed by
    // touchPersistentSubagentInactivityTimer on each delivered response.
    const { expiresAtMs: expiresAt, dispose: clearTtl } = armPersistentSubagentInactivityTimer(
      {
        sessions,
        onTimeout: (sid) => terminatePersistentSubagentSession(sessionManager, sid, "ttl_expired"),
      },
      s.id,
      validExpiry !== undefined ? { expiresAtMs: validExpiry } : {},
    );

    rememberSubagentHandles(s.id, {
      unregisterThread,
      unsubscribeBus,
      clearTtl,
    });
    restored++;
    log.info("subagent.reconcile.restored", {
      sessionId: s.id,
      threadId: threadId ?? null,
      expires_at_ms: expiresAt,
    });
  }

  return { restored, expiredKilled };
}
