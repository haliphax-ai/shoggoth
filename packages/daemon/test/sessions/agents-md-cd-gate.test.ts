import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register as registerCd } from "../../src/sessions/builtin-handlers/cd-handler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-cd-gate-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function makeCtx(
  db: Database.Database,
  sessionId: string,
  workspacePath: string,
  workingDirectory?: string,
) {
  return {
    sessionId,
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: process.env,
    workspacePath,
    workingDirectory,
    creds: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoryConfig: {} as any,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("cd handler AGENTS.md gate", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(wsPath, "sub"), { recursive: true });
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("gates cd when AGENTS.md exists in cwd", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });
    writeFileSync(join(wsPath, "sub", "AGENTS.md"), "# Sub rules");

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    // cd from workspace root into sub — cwd is workspace root, so gate checks workspace root (excluded)
    // We need to be IN sub for the gate to fire, so let's set workingDirectory to sub
    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "sub"));
    const result = await registry.execute("cd", { path: "." }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.strictEqual(json.gated, true);
    assert.ok(json.files.length > 0);
  });

  it("allows cd after AGENTS.md has been seen", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });
    writeFileSync(join(wsPath, "sub", "AGENTS.md"), "# Sub rules");

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "sub"));
    // First call — gated
    await registry.execute("cd", { path: "." }, ctx);
    // Second call — should proceed
    const result = await registry.execute("cd", { path: join(wsPath, "sub") }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(!json.gated);
    assert.ok(json.workingDirectory);
  });
});
