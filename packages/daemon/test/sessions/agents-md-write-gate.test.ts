import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handlers";
import { register as registerSearchReplace } from "../../src/sessions/builtin-handlers/search-replace-handler";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-write-gate-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function makeCtx(
  db: Database.Database,
  workspacePath: string,
  workingDirectory?: string,
): BuiltinToolContext {
  return {
    sessionId: "s1",
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
    memoryConfig: { paths: [], embeddings: { enabled: false } } as any,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("write handler AGENTS.md gate", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("gates write when AGENTS.md exists in cwd", async () => {
    const sub = join(wsPath, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "# Write rules");

    const registry = new BuiltinToolRegistry();
    registerFs(registry);

    const ctx = makeCtx(db, wsPath, sub);
    const result = await registry.execute("write", { path: "foo.txt", content: "hello" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.strictEqual(json.gated, true);
  });

  it("allows write after AGENTS.md has been seen", async () => {
    const sub = join(wsPath, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "# Write rules");

    const registry = new BuiltinToolRegistry();
    registerFs(registry);

    const ctx = makeCtx(db, wsPath, sub);
    // First call — gated
    await registry.execute("write", { path: "foo.txt", content: "hello" }, ctx);
    // Second call — should proceed
    const result = await registry.execute("write", { path: "foo.txt", content: "hello" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.strictEqual(json.ok, true);
  });
});

describe("search-replace handler AGENTS.md gate", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("gates replace when AGENTS.md exists in cwd", async () => {
    const sub = join(wsPath, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "# Replace rules");
    writeFileSync(join(sub, "target.txt"), "old content");

    const registry = new BuiltinToolRegistry();
    registerSearchReplace(registry);

    const ctx = makeCtx(db, wsPath, sub);
    const result = await registry.execute(
      "search-replace",
      {
        action: "replace",
        file: "target.txt",
        match: "old",
        replacement: "new",
      },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    assert.strictEqual(json.gated, true);
  });

  it("does NOT gate search action", async () => {
    const sub = join(wsPath, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "# Search rules");
    writeFileSync(join(sub, "target.txt"), "some content");

    const registry = new BuiltinToolRegistry();
    registerSearchReplace(registry);

    const ctx = makeCtx(db, wsPath, sub);
    const result = await registry.execute(
      "search-replace",
      {
        action: "search",
        pattern: "some",
      },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    // Should not be gated — search is read-only
    assert.ok(!json.gated);
  });
});
