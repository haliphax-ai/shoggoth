import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { checkAgentsMdGate } from "../../src/sessions/agents-md-gate";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-agents-md-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("checkAgentsMdGate", () => {
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

  it("returns null when no AGENTS.md files exist below workspace root", () => {
    mkdirSync(join(wsPath, "sub"), { recursive: true });
    const result = checkAgentsMdGate(db, "s1", join(wsPath, "sub"), wsPath);
    assert.strictEqual(result, null);
  });

  it("gates on a new AGENTS.md in a subdirectory", () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "# Sub instructions");

    const result = checkAgentsMdGate(db, "s1", subDir, wsPath);
    assert.ok(result);
    assert.strictEqual(result!.gated, true);
    assert.strictEqual(result!.files.length, 1);
    assert.strictEqual(result!.files[0].content, "# Sub instructions");
    assert.ok(result!.files[0].path.includes("sub/AGENTS.md"));
  });

  it("allows through after file has been seen", () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "# Sub instructions");

    // First call gates
    const r1 = checkAgentsMdGate(db, "s1", subDir, wsPath);
    assert.ok(r1);

    // Second call passes through
    const r2 = checkAgentsMdGate(db, "s1", subDir, wsPath);
    assert.strictEqual(r2, null);
  });

  it("gates again when file is modified", () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "v1");

    // See it
    checkAgentsMdGate(db, "s1", subDir, wsPath);

    // Modify — change mtime
    const future = new Date(Date.now() + 5000);
    writeFileSync(join(subDir, "AGENTS.md"), "v2");
    utimesSync(join(subDir, "AGENTS.md"), future, future);

    const r2 = checkAgentsMdGate(db, "s1", subDir, wsPath);
    assert.ok(r2);
    assert.strictEqual(r2!.files[0].content, "v2");
  });

  it("does NOT include workspace root AGENTS.md", () => {
    writeFileSync(join(wsPath, "AGENTS.md"), "# Root");
    const result = checkAgentsMdGate(db, "s1", wsPath, wsPath);
    assert.strictEqual(result, null);
  });

  it("returns files in ancestor-first order", () => {
    const a = join(wsPath, "a");
    const ab = join(a, "b");
    mkdirSync(ab, { recursive: true });
    writeFileSync(join(a, "AGENTS.md"), "# A");
    writeFileSync(join(ab, "AGENTS.md"), "# B");

    const result = checkAgentsMdGate(db, "s1", ab, wsPath);
    assert.ok(result);
    assert.strictEqual(result!.files.length, 2);
    assert.ok(result!.files[0].path.includes("a/AGENTS.md"));
    assert.ok(result!.files[1].path.includes("a/b/AGENTS.md"));
  });

  it("different sessions have independent state", () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "# Sub");

    // Session 1 sees it
    checkAgentsMdGate(db, "s1", subDir, wsPath);

    // Session 2 should still gate
    const r2 = checkAgentsMdGate(db, "s2", subDir, wsPath);
    assert.ok(r2);
  });

  it("walks up from cwd to workspace root (exclusive)", () => {
    // cwd is wsPath/a/b/c, AGENTS.md at wsPath/a/
    const deep = join(wsPath, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(wsPath, "a", "AGENTS.md"), "# A level");

    const result = checkAgentsMdGate(db, "s1", deep, wsPath);
    assert.ok(result);
    assert.strictEqual(result!.files.length, 1);
    assert.ok(result!.files[0].path.includes("a/AGENTS.md"));
  });
});
