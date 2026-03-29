/**
 * Run inside the Shoggoth container (see readiness-compose.test.mjs).
 * Creates fixed session rows + workspace dirs for Discord route IDs (`skills/`, `memory/`, …).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionStore,
  defaultMigrationsDir,
  ensureAgentWorkspaceLayout,
  migrate,
  openStateDb,
} from "@shoggoth/daemon/lib";

const dbPath = "/var/lib/shoggoth/state/shoggoth.db";
const sessions = [
  { id: "readiness-guild", dir: "/var/lib/shoggoth/workspaces/readiness-guild" },
  { id: "readiness-dm", dir: "/var/lib/shoggoth/workspaces/readiness-dm" },
];

const db = openStateDb(dbPath);
try {
  migrate(db, defaultMigrationsDir());
  const store = createSessionStore(db);
  for (const s of sessions) {
    ensureAgentWorkspaceLayout(s.dir);
    mkdirSync(join(s.dir, "memory"), { recursive: true, mode: 0o770 });
    writeFileSync(
      `${s.dir}/skills/readiness-skill.md`,
      "---\ntitle: Readiness skill\n---\n# Readiness\nSkill body for scanRoots test.\n",
    );
    writeFileSync(
      `${s.dir}/memory/note.md`,
      "# Memory note\n\nreadiness-alpha unique phrase for FTS.\n",
    );
    if (!store.getById(s.id)) {
      store.create({
        id: s.id,
        workspacePath: s.dir,
        status: "active",
        runtimeUid: 901,
        runtimeGid: 901,
      });
    }
  }
} finally {
  db.close();
}
console.log(JSON.stringify({ ok: true, sessions: sessions.map((s) => s.id) }));
