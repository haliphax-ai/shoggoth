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
 * Ensures every configured agent's workspace and primary session row exist.
 *
 * Iterates `config.agents.list` — for each agent:
 * 1. Creates workspace directory + subdirs (memory, tmp, skills, template files)
 * 2. Resolves session id from the agent's first platform route
 * 3. Inserts the session row if missing
 *
 * Backward-compatible: if no agents are configured, falls back to bootstrapping
 * a single "main" agent using `config.runtime?.agentId`.
 */
export function bootstrapMainSession(opts: BootstrapMainSessionOptions): void {
  const log = getLogger("bootstrap");
  const { db, config } = opts;

  const agentsList = config.agents?.list;
  if (agentsList && Object.keys(agentsList).length > 0) {
    for (const [agentId, agentEntry] of Object.entries(agentsList)) {
      bootstrapAgent(db, config, agentId, agentEntry, log);
    }
  } else {
    // Fallback: single agent from runtime config
    const agentId = config.runtime?.agentId?.trim() || "main";
    const agentEntry = config.agents?.list?.[agentId];
    bootstrapAgent(db, config, agentId, agentEntry, log);
  }
}

function bootstrapAgent(
  db: Database.Database,
  config: ShoggothConfig,
  agentId: string,
  agentEntry: Record<string, unknown> | undefined,
  log: ReturnType<typeof getLogger>,
): void {
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
  const agentPlatform = agentEntry
    ? resolveAgentPlatformConfig(agentEntry, platform)
    : undefined;
  const firstRoute = (agentPlatform?.routes as Array<{ sessionId?: string }> | undefined)?.[0];
  const id =
    firstRoute?.sessionId?.trim() ||
    resolveBootstrapPrimarySessionUrn(agentId, platform);

  // Create workspace layout (dirs + template files)
  ensureAgentWorkspaceLayout(dir);

  const store = createSessionStore(db);
  const existing = store.getById(id);

  if (existing) {
    log.debug("bootstrap.agent.session_exists", { sessionId: id, agentId });
    return;
  }

  // Resolve agent UID/GID for the session row
  let runtimeUid: number;
  let runtimeGid: number;
  try {
    runtimeUid = Number(execSync("id -u agent", { encoding: "utf8" }).trim());
    runtimeGid = Number(execSync("id -g agent", { encoding: "utf8" }).trim());
  } catch {
    runtimeUid = 900;
    runtimeGid = 900;
  }

  store.create({
    id,
    workspacePath: dir,
    status: "active",
    runtimeUid,
    runtimeGid,
  });

  pushSystemContext(id, "Fresh session. No prior conversation history.");
  log.info("bootstrap.agent.session_created", { sessionId: id, agentId, workspacePath: dir });
}
