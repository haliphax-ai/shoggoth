import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-cwd-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("SessionStore working_directory", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("defaults workingDirectory to undefined on new session", () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: "/ws/a" });
    const row = store.getById("s1");
    assert.ok(row);
    assert.equal(row!.workingDirectory, undefined);
  });

  it("persists workingDirectory via update", () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: "/ws/a" });
    store.update("s1", { workingDirectory: "/ws/a/subdir" });
    const row = store.getById("s1");
    assert.ok(row);
    assert.equal(row!.workingDirectory, "/ws/a/subdir");
  });

  it("clears workingDirectory when set to null", () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: "/ws/a" });
    store.update("s1", { workingDirectory: "/ws/a/subdir" });
    store.update("s1", { workingDirectory: null });
    const row = store.getById("s1");
    assert.ok(row);
    assert.equal(row!.workingDirectory, undefined);
  });

  it("preserves workingDirectory when update does not include it", () => {
    const store = createSessionStore(db);
    store.create({ id: "s1", workspacePath: "/ws/a" });
    store.update("s1", { workingDirectory: "/ws/a/subdir" });
    store.update("s1", { status: "terminated" });
    const row = store.getById("s1");
    assert.ok(row);
    assert.equal(row!.workingDirectory, "/ws/a/subdir");
  });
});
