import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register as registerCd } from "../../src/sessions/builtin-handlers/cd-handler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-cd-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function makeCtx(db: Database.Database, sessionId: string, workspacePath: string, workingDirectory?: string) {
  return {
    sessionId,
    db,
    config: {} as any,
    env: process.env,
    workspacePath,
    workingDirectory,
    creds: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: {} as any,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("builtin-cd handler", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(wsPath, "subdir"), { recursive: true });
    mkdirSync(join(wsPath, "subdir", "nested"), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers as 'cd' in the registry", () => {
    const registry = new BuiltinToolRegistry();
    registerCd(registry);
    assert.ok(registry.has("cd"));
  });

  it("changes to absolute path within workspace", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const subdir = join(wsPath, "subdir");
    const result = await registry.execute("cd", { path: subdir }, makeCtx(db, "s1", wsPath));
    const json = JSON.parse(result.resultJson);
    assert.equal(json.workingDirectory, subdir);

    // Verify persisted
    const row = store.getById("s1");
    assert.equal(row!.workingDirectory, subdir);
  });

  it("resolves relative path from current working directory", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });
    store.update("s1", { workingDirectory: join(wsPath, "subdir") });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("cd", { path: "nested" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.workingDirectory, join(wsPath, "subdir", "nested"));
  });

  it("rejects path outside workspace", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const result = await registry.execute("cd", { path: "/tmp" }, makeCtx(db, "s1", wsPath));
    const json = JSON.parse(result.resultJson);
    assert.ok(json.error);
  });

  it("rejects relative path that escapes workspace", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const result = await registry.execute("cd", { path: "../../.." }, makeCtx(db, "s1", wsPath));
    const json = JSON.parse(result.resultJson);
    assert.ok(json.error);
  });

  it("resets to workspace root when path is empty", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });
    store.update("s1", { workingDirectory: join(wsPath, "subdir") });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const result = await registry.execute("cd", { path: "" }, makeCtx(db, "s1", wsPath, join(wsPath, "subdir")));
    const json = JSON.parse(result.resultJson);
    assert.equal(json.workingDirectory, wsPath);

    const row = store.getById("s1");
    assert.equal(row!.workingDirectory, undefined);
  });

  it("resets to workspace root when no path arg", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });
    store.update("s1", { workingDirectory: join(wsPath, "subdir") });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const result = await registry.execute("cd", {}, makeCtx(db, "s1", wsPath, join(wsPath, "subdir")));
    const json = JSON.parse(result.resultJson);
    assert.equal(json.workingDirectory, wsPath);
  });

  it("rejects path to non-existent directory", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerCd(registry);

    const result = await registry.execute("cd", { path: "nonexistent" }, makeCtx(db, "s1", wsPath));
    const json = JSON.parse(result.resultJson);
    assert.ok(json.error);
  });
});
