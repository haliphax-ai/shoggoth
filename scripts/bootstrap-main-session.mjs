/**
 * Ensures session `main` + workspace tree exist (Discord route target).
 * Layout: `skills/`, `memory/` (for `memory.paths` → `memory` + `memory.ingest`), template markdown.
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
} from "@shoggoth/daemon/lib";

const dbPath = "/var/lib/shoggoth/state/shoggoth.db";
const id = "main";
const dir = "/var/lib/shoggoth/workspaces/main";

const db = openStateDb(dbPath);
try {
  migrate(db, defaultMigrationsDir());
  const store = createSessionStore(db);
  ensureAgentWorkspaceLayout(dir);
  // Explicit: operators expect `memory/` for built-in memory tools (also created by ensureAgentWorkspaceLayout).
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
console.log(JSON.stringify({ ok: true, sessionId: id, workspacePath: dir }));
