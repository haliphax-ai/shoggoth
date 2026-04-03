import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  resolveAgentPlatformConfig,
  resolveAgentWorkspacePath,
} from "@shoggoth/shared";
import { createSessionStore } from "./sessions/session-store";
import { ensureAgentWorkspaceLayout } from "./workspaces/agent-workspace-layout";
import { resolveBootstrapPrimarySessionUrn } from "@shoggoth/messaging";
import { pushSystemContext } from "./sessions/system-context-buffer";
import { getLogger } from "./logging";

interface BootstrapMainSessionOptions {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
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
  const log = getLogger("bootstrap");
  const { db, config } = opts;

  const agentId = config.runtime?.agentId?.trim() || "main";

  // Always derive platform from the agent's platform bindings.
  const agentEntry = config.agents?.list?.[agentId];
  const platformKeys = agentEntry?.platforms ? Object.keys(agentEntry.platforms) : [];
  if (platformKeys.length === 0) {
    throw new Error(
      `No platform bindings configured for agent "${agentId}". ` +
      `Add at least one platform under agents.list.${agentId}.platforms.`,
    );
  }
  const platform = platformKeys[0];
  if (platformKeys.length > 1) {
    log.info("bootstrap.main_session.platform_inferred", {
      agentId,
      platform,
      available: platformKeys,
      detail: `Inferred default platform "${platform}" from agent bindings (${platformKeys.length} available).`,
    });
  }
  const wsRoot = config.workspacesRoot;
  const dir = resolveAgentWorkspacePath(wsRoot, agentId);

  // Resolve session id from the agent's first platform route.
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
    log.debug("bootstrap.main_session.exists", { sessionId: id, agentId });
    return;
  }

  // Check if the DB already has sessions (i.e. not a fresh DB).
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
  ).n;

  if (count > 0) {
    log.warn("bootstrap.main_session.missing", {
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
    runtimeUid: Number(execSync("id -u agent", { encoding: "utf8" }).trim()),
    runtimeGid: Number(execSync("id -g agent", { encoding: "utf8" }).trim()),
  });

  pushSystemContext(id, "Fresh session. No prior conversation history.");
  log.info("bootstrap.main_session.created", { sessionId: id, agentId, workspacePath: dir });
}
