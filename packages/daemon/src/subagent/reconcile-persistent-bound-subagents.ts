import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { createSqliteAgentTokenStore } from "../auth/sqlite-agent-tokens";
import { resolveDefaultSessionPlatform, resolveShoggothAgentId } from "../config/effective-runtime";
import type { Logger } from "../logging";
import { createSessionManager } from "../sessions/session-manager";
import { createSessionStore } from "../sessions/session-store";
import { SUBAGENT_DEFAULT_BOUND_LIFETIME_MS } from "./subagent-constants";
import { rememberSubagentHandles } from "./subagent-disposables";
import type { SubagentRuntimeExtension } from "./subagent-extension-ref";
import { terminateBoundSubagentSession } from "./subagent-kill";

export type ReconcilePersistentBoundSubagentsResult = {
  readonly restored: number;
  readonly expiredKilled: number;
};

/**
 * After a process restart, reattach Discord thread routing, A2A bus subscriptions, and TTL timers for
 * bound subagents that are still persisted in SQLite as active.
 */
export function reconcilePersistentBoundSubagents(input: {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly logger: Logger;
  readonly ext: SubagentRuntimeExtension;
}): ReconcilePersistentBoundSubagentsResult {
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
      s.subagentMode === "bound" &&
      s.status !== "terminated" &&
      Boolean(s.subagentDiscordThreadId?.trim()),
  );

  let restored = 0;
  let expiredKilled = 0;
  const now = Date.now();

  for (const s of candidates) {
    const threadId = s.subagentDiscordThreadId!.trim();
    let expiresAt = s.subagentExpiresAtMs;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      expiresAt = now + SUBAGENT_DEFAULT_BOUND_LIFETIME_MS;
      sessions.update(s.id, { subagentExpiresAtMs: expiresAt });
    }

    if (expiresAt <= now) {
      terminateBoundSubagentSession(sessionManager, s.id, "ttl_expired");
      expiredKilled++;
      input.logger.info("subagent.reconcile.expired_killed", { sessionId: s.id });
      continue;
    }

    const unregisterThread = input.ext.registerDiscordThreadBinding(threadId, s.id);
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
      terminateBoundSubagentSession(sessionManager, s.id, "ttl_expired");
    }, remainingMs);

    rememberSubagentHandles(s.id, {
      unregisterThread,
      unsubscribeBus,
      clearTtl,
    });
    restored++;
    input.logger.info("subagent.reconcile.restored", {
      sessionId: s.id,
      threadId,
      expires_at_ms: expiresAt,
    });
  }

  return { restored, expiredKilled };
}
