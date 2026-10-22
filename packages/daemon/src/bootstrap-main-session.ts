import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { resolveAgentPlatformConfig, resolveAgentWorkspacePath } from "@shoggoth/shared";
import { createSessionStore } from "./sessions/session-store";
import { resolveAgentCreds } from "./agent-creds";
import { ensureAgentWorkspaceLayout } from "./workspaces/agent-workspace-layout";
import { resolveBootstrapPrimarySessionUrn } from "@shoggoth/messaging";
import { pushSystemContext } from "./sessions/system-context-buffer";
import { getLogger } from "./logging";

interface BootstrapMainSessionOptions {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
}

/**
 * Ensures every configured agent's workspace and primary session row exist.
 *
 * 1. Creates workspace directory + subdirs (skills, memory, tmp, prompts,
 *    media/inbound + template files) with default ACLs for the daemon uid
 * 1. Creates workspace directory + subdirs (memory, tmp, skills, template files)
 * 2. Resolves session id from the agent's first platform route
 * 3. Inserts the session row if missing
 *
 * Backward-compatible: if no agents are configured, falls back to bootstrapping
 * a single "main" agent using `config.runtime?.agentId`.
 */
export async function bootstrapMainSession(opts: BootstrapMainSessionOptions): Promise<void> {
  const log = getLogger("bootstrap");
  const { db, config } = opts;

  const agentsList = config.agents?.list;
  if (agentsList && Object.keys(agentsList).length > 0) {
    for (const [agentId, agentEntry] of Object.entries(agentsList)) {
      await bootstrapAgent(db, config, agentId, agentEntry, log);
    }
  } else {
    // Fallback: single agent from runtime config
    const agentId = config.runtime?.agentId?.trim() || "main";
    const agentEntry = config.agents?.list?.[agentId];
    await bootstrapAgent(db, config, agentId, agentEntry, log);
  }
}

async function bootstrapAgent(
  db: Database.Database,
  config: ShoggothConfig,
  agentId: string,
  agentEntry: Record<string, unknown> | undefined,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const platformKeys = agentEntry?.platforms
    ? Object.keys(agentEntry.platforms as Record<string, unknown>)
    : [];

  if (platformKeys.length === 0) {
    log.warn("bootstrap.agent.no_platforms", {
      agentId,
      detail: `No platform bindings for agent "${agentId}"; skipping session bootstrap.`,
    });
    return;
  }

  const platform = platformKeys[0];
  const wsRoot = config.workspacesRoot;
  const dir = resolveAgentWorkspacePath(wsRoot, agentId);

  // Resolve session id from the agent's first platform route
  const agentPlatform = agentEntry ? resolveAgentPlatformConfig(agentEntry, platform) : undefined;
  const firstRoute = (agentPlatform?.routes as Array<{ sessionId?: string }> | undefined)?.[0];
  const id = firstRoute?.sessionId?.trim() || resolveBootstrapPrimarySessionUrn(agentId, platform);

  // Resolve agent UID/GID for the session row (must happen before workspace
  // creation). The daemon is never the agent user: process credentials are the
  // daemon's identity, so they must never be stamped onto the session row.
  const { uid: runtimeUid, gid: runtimeGid } = resolveAgentCreds();

  // Create workspace layout (dirs + template files, incl. default ACLs for the
  // daemon uid) as the agent user
  await ensureAgentWorkspaceLayout(dir, { uid: runtimeUid, gid: runtimeGid });

  const store = createSessionStore(db);
  const existing = store.getById(id);

  if (existing) {
    if (existing.runtimeUid !== runtimeUid || existing.runtimeGid !== runtimeGid) {
      // Repair rows stamped by older bootstraps (e.g. with the daemon's own
      // process credentials) so exec runs as the agent user.
      store.update(id, { runtimeUid, runtimeGid });
      log.info("bootstrap.agent.session_creds_repaired", {
        sessionId: id,
        agentId,
        fromUid: existing.runtimeUid,
        toUid: runtimeUid,
        fromGid: existing.runtimeGid,
        toGid: runtimeGid,
      });
    } else {
      log.debug("bootstrap.agent.session_exists", { sessionId: id, agentId });
    }
    return;
  }

  store.create({
    id,
    workspacePath: dir,
    status: "active",
    runtimeUid,
    runtimeGid,
  });

  pushSystemContext(id, "Fresh session. No prior conversation history.");
  log.info("bootstrap.agent.session_created", {
    sessionId: id,
    agentId,
    workspacePath: dir,
  });
}
