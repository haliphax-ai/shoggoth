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
import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handler";
import { register as registerFsHandlers } from "../../src/sessions/builtin-handlers/fs-handlers";
import { register as registerLs } from "../../src/sessions/builtin-handlers/ls-handler";
import { register as registerExec } from "../../src/sessions/builtin-handlers/exec-handler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-cwdint-"));
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

describe("BuiltinToolContext workingDirectory integration", () => {
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
    writeFileSync(join(wsPath, "root.txt"), "root-content");
    writeFileSync(join(wsPath, "subdir", "child.txt"), "child-content");
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("read resolves relative path from workingDirectory", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerFsHandlers(registry);

    // With workingDirectory set to subdir, reading "child.txt" should work
    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("read", { path: "child.txt" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(!json.error, `unexpected error: ${json.error}`);
    assert.ok(json.content?.includes("child-content"));
  });

  it("read still works with absolute paths when workingDirectory is set", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerFsHandlers(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("read", { path: join(wsPath, "root.txt") }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(!json.error, `unexpected error: ${json.error}`);
    assert.ok(json.content?.includes("root-content"));
  });

  it("write resolves relative path from workingDirectory", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerFsHandlers(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("write", { path: "new.txt", content: "hello" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(json.ok, `unexpected error: ${JSON.stringify(json)}`);

    // Verify the file was written in subdir
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(join(wsPath, "subdir", "new.txt"), "utf8");
    assert.equal(content, "hello");
  });

  it("exec uses workingDirectory as cwd", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerExec(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("exec", { argv: ["pwd"] }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.exitCode, 0);
    assert.ok(
      json.stdout?.trim().endsWith("subdir"),
      `expected cwd to be subdir, got: ${json.stdout}`,
    );
  });

  it("ls uses workingDirectory as default path", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerLs(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("ls", { path: "." }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(!json.error, `unexpected error: ${json.error}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = json.entries?.map((e: any) => e.path) ?? [];
    assert.ok(
      names.includes("child.txt"),
      `expected child.txt in ls output, got: ${JSON.stringify(names)}`,
    );
  });

  it("fs stat resolves relative path from workingDirectory", async () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: wsPath, status: "active" });

    const registry = new BuiltinToolRegistry();
    registerFs(registry);

    const ctx = makeCtx(db, "s1", wsPath, join(wsPath, "subdir"));
    const result = await registry.execute("fs", { action: "stat", path: "child.txt" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.ok(json.ok, `unexpected error: ${JSON.stringify(json)}`);
    assert.equal(json.type, "file");
  });

  it("subagent inherits parent workingDirectory via session store", () => {
    const store = createSessionStore(db);
    store.create({ id: "parent", workspacePath: wsPath, status: "active" });
    store.update("parent", { workingDirectory: join(wsPath, "subdir") });

    // Simulate subagent spawn: create child and copy parent's workingDirectory
    const parent = store.getById("parent")!;
    store.create({ id: "child", workspacePath: wsPath, status: "active" });
    store.update("child", {
      workingDirectory: parent.workingDirectory ?? null,
    });

    const child = store.getById("child")!;
    assert.equal(child.workingDirectory, join(wsPath, "subdir"));
  });

  it("subagent defaults to undefined workingDirectory when parent has none", () => {
    const store = createSessionStore(db);
    store.create({ id: "parent", workspacePath: wsPath, status: "active" });

    const parent = store.getById("parent")!;
    store.create({ id: "child", workspacePath: wsPath, status: "active" });
    store.update("child", {
      workingDirectory: parent.workingDirectory ?? null,
    });

    const child = store.getById("child")!;
    assert.equal(child.workingDirectory, undefined);
  });
});
