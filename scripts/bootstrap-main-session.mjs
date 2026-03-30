/**
 * Ensures default agent workspace + primary Discord session row exist.
 * Workspace path: `{SHOGGOTH_WORKSPACES_ROOT||/var/lib/shoggoth/workspaces}/{SHOGGOTH_AGENT_ID||main}`.
 * Session id: `agent:{agentId}:discord:{channelId}` when `SHOGGOTH_DISCORD_ROUTES` / `SHOGGOTH_PRIMARY_DISCORD_CHANNEL_ID`
 * supplies a channel snowflake; otherwise `…:{SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID}` (see `resolveBootstrapPrimarySessionUrn` in @shoggoth/shared / daemon).
 * Run inside the container: `node --import tsx/esm scripts/bootstrap-main-session.mjs`
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionStore,
  defaultMigrationsDir,
  ensureAgentWorkspaceLayout,
  migrate,
  openStateDb,
  resolveBootstrapPrimarySessionUrn,
} from "@shoggoth/daemon/lib";
import { resolveAgentWorkspacePath } from "@shoggoth/shared";

const dbPath = "/var/lib/shoggoth/state/shoggoth.db";
const wsRoot = process.env.SHOGGOTH_WORKSPACES_ROOT?.trim() || "/var/lib/shoggoth/workspaces";
const agentId = process.env.SHOGGOTH_AGENT_ID?.trim() || "main";
const platform = process.env.SHOGGOTH_DEFAULT_SESSION_PLATFORM?.trim() || "discord";
const dir = resolveAgentWorkspacePath(wsRoot, agentId);
const id = resolveBootstrapPrimarySessionUrn(agentId, platform, {
  primaryChannelId: process.env.SHOGGOTH_PRIMARY_DISCORD_CHANNEL_ID,
  routesJson: process.env.SHOGGOTH_DISCORD_ROUTES,
});

const db = openStateDb(dbPath);
try {
  migrate(db, defaultMigrationsDir());
  const store = createSessionStore(db);
  ensureAgentWorkspaceLayout(dir);
  mkdirSync(join(dir, "memory"), { recursive: true, mode: 0o770 });
  if (!store.getById(id)) {
    store.create({
      id,
      workspacePath: dir,
      status: "active",
      runtimeUid: 901,
      runtimeGid: 901,
    });
  }
} finally {
  db.close();
}
console.log(JSON.stringify({ ok: true, sessionId: id, agentId, workspacePath: dir }));
