import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  resolveAgentPlatformConfig,
  resolveAgentWorkspacePath,
} from "@shoggoth/shared";
import { createSessionStore } from "./sessions/session-store";
import { ensureAgentWorkspaceLayout } from "./workspaces/agent-workspace-layout";
import { resolveBootstrapPrimarySessionUrn } from "@shoggoth/messaging";
import type { Logger } from "./logging";

export interface BootstrapMainSessionOptions {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly logger: Logger;
}

/**
 * Ensures the main agent's workspace and primary session row exist.
 *
 * Session id is pulled from the agent's first configured platform route
 * (`agents.list.<agentId>.platforms.<platform>.routes[0].sessionId`),
 * falling back to `resolveBootstrapPrimarySessionUrn`.
 *
 * - New DB (no prior sessions): bootstraps cleanly without warnings.
 * - Existing DB without a matching session: logs a warning, then hydrates.
 */
export function bootstrapMainSession(opts: BootstrapMainSessionOptions): void {
  const { db, config, logger } = opts;

  const agentId = config.runtime?.agentId?.trim() || "main";
  const platform = config.runtime?.defaultSessionPlatform?.trim();
  if (!platform) {
    logger.warn("bootstrap.main_session.no_platform", {
      detail: "runtime.defaultSessionPlatform is not configured; skipping main session bootstrap",
    });
    return;
  }
  const wsRoot = config.workspacesRoot;
  const dir = resolveAgentWorkspacePath(wsRoot, agentId);

  // Resolve session id from the agent's first platform route.
  const agentEntry = config.agents?.list?.[agentId];
  const agentPlatform = agentEntry
    ? resolveAgentPlatformConfig(agentEntry, platform)
    : undefined;
  const firstRoute = (agentPlatform?.routes as Array<{ sessionId?: string }> | undefined)?.[0];
  const id =
    firstRoute?.sessionId?.trim() ||
    resolveBootstrapPrimarySessionUrn(agentId, platform);

  ensureAgentWorkspaceLayout(dir);
  mkdirSync(join(dir, "memory"), { recursive: true, mode: 0o770 });

  const store = createSessionStore(db);
  const existing = store.getById(id);

  if (existing) {
    logger.debug("bootstrap.main_session.exists", { sessionId: id, agentId });
    return;
  }

  // Check if the DB already has sessions (i.e. not a fresh DB).
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
  ).n;

  if (count > 0) {
    logger.warn("bootstrap.main_session.missing", {
      sessionId: id,
      agentId,
      existingSessions: count,
      detail:
        `Session ${id} not found in existing database (${count} other session(s)). Hydrating anyway.`,
    });
  }

  store.create({
    id,
    workspacePath: dir,
    status: "active",
    runtimeUid: 901,
    runtimeGid: 901,
  });

  logger.info("bootstrap.main_session.created", { sessionId: id, agentId, workspacePath: dir });
}
