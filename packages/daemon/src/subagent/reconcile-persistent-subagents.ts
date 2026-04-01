import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { createSqliteAgentTokenStore } from "../auth/sqlite-agent-tokens";
import { resolveDefaultSessionPlatform, resolveShoggothAgentId } from "../config/effective-runtime";
import type { Logger } from "../logging";
import { createSessionManager } from "../sessions/session-manager";
import { createSessionStore } from "../sessions/session-store";
import { SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS } from "./subagent-constants";
import { rememberSubagentHandles } from "./subagent-disposables";
import type { SubagentRuntimeExtension } from "./subagent-extension-ref";
import { terminatePersistentSubagentSession } from "./subagent-kill";

export type ReconcilePersistentSubagentsResult = {
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
  readonly logger: Logger;
  readonly ext: SubagentRuntimeExtension;
}): ReconcilePersistentSubagentsResult {
  const sessions = createSessionStore(input.db);
  const sessionManager = createSessionManager({
    db: input.db,
    sessions,
    agentTokens: createSqliteAgentTokenStore(input.db),
    workspacesRoot: input.config.workspacesRoot,
    agentId: resolveShoggothAgentId(input.config),
    defaultSessionPlatform: resolveDefaultSessionPlatform(input.config),
  });

  const candidates = sessions.list().filter(
    (s) =>
      s.subagentMode === "persistent" &&
      s.status !== "terminated",
  );

  let restored = 0;
  let expiredKilled = 0;
  const now = Date.now();

  for (const s of candidates) {
    const threadId = s.subagentPlatformThreadId?.trim() || undefined;
    let expiresAt = s.subagentExpiresAtMs;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      expiresAt = now + SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS;
      sessions.update(s.id, { subagentExpiresAtMs: expiresAt });
    }

    if (expiresAt <= now) {
      terminatePersistentSubagentSession(sessionManager, s.id, "ttl_expired");
      expiredKilled++;
      input.logger.info("subagent.reconcile.expired_killed", { sessionId: s.id });
      continue;
    }

    const unregisterThread = threadId
      ? input.ext.registerPlatformThreadBinding(threadId, s.id)
      : () => {};
    const unsubscribeBus = input.ext.subscribeSubagentSession(s.id);
    let ttlTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTtl = () => {
      if (ttlTimer !== undefined) {
        clearTimeout(ttlTimer);
        ttlTimer = undefined;
      }
    };
    const remainingMs = expiresAt - now;
    ttlTimer = setTimeout(() => {
      ttlTimer = undefined;
      terminatePersistentSubagentSession(sessionManager, s.id, "ttl_expired");
    }, remainingMs);

    rememberSubagentHandles(s.id, {
      unregisterThread,
      unsubscribeBus,
      clearTtl,
    });
    restored++;
    input.logger.info("subagent.reconcile.restored", {
      sessionId: s.id,
      threadId: threadId ?? null,
      expires_at_ms: expiresAt,
    });
  }

  return { restored, expiredKilled };
}
