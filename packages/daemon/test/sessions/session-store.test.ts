import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore, type SessionStatus } from "../../src/sessions/session-store";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-sess-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("SessionStore", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates and reads a session", () => {
    const store = createSessionStore(db);
    store.create({
      id: "s1",
      workspacePath: "/ws/a",
      status: "active",
      modelSelection: { model: "gpt-4" },
    });
    const row = store.getById("s1");
    assert.ok(row);
    assert.equal(row!.id, "s1");
    assert.equal(row!.workspacePath, "/ws/a");
    assert.equal(row!.status, "active");
    assert.deepEqual(row!.modelSelection, { model: "gpt-4" });
    assert.equal(row!.lightContext, false);
    assert.deepEqual(row!.promptStack, []);
  });

  it("updates status and runtime binding", () => {
    const store = createSessionStore(db);
    store.create({ id: "s2", workspacePath: "/w", status: "starting" });
    store.update("s2", { status: "active", runtimeUid: 1000, runtimeGid: 1000 });
    const row = store.getById("s2");
    assert.equal(row!.status, "active");
    assert.equal(row!.runtimeUid, 1000);
    assert.equal(row!.runtimeGid, 1000);
  });

  it("deletes session", () => {
    const store = createSessionStore(db);
    store.create({ id: "s3", workspacePath: "/w" });
    store.delete("s3");
    assert.equal(store.getById("s3"), undefined);
  });

  it("lists sessions by status filter", () => {
    const store = createSessionStore(db);
    store.create({ id: "a", workspacePath: "/1", status: "active" });
    store.create({ id: "b", workspacePath: "/2", status: "terminated" });
    const active = store.list({ status: "active" as SessionStatus });
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, "a");
  });
});
