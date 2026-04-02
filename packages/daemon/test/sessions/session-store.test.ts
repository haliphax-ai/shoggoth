import { describe, it, beforeEach, afterEach } from "vitest";
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

  it("exposes createdAt and updatedAt on session rows", () => {
    const store = createSessionStore(db);
    store.create({ id: "ts1", workspacePath: "/w", status: "active" });
    const row = store.getById("ts1");
    assert.ok(row);
    assert.ok(row!.createdAt, "createdAt should be set");
    assert.ok(row!.updatedAt, "updatedAt should be set");
    // Both should be valid datetime strings
    assert.ok(!Number.isNaN(Date.parse(row!.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(row!.updatedAt)));
  });

  it("list returns createdAt and updatedAt", () => {
    const store = createSessionStore(db);
    store.create({ id: "ts2", workspacePath: "/w", status: "active" });
    const rows = store.list();
    assert.ok(rows.length >= 1);
    const row = rows.find((r) => r.id === "ts2");
    assert.ok(row);
    assert.ok(row!.createdAt);
    assert.ok(row!.updatedAt);
  });

  describe("sort / filter / limit", () => {
    /**
     * Helper: create sessions with explicit timestamps via direct SQL update
     * so we can control ordering deterministically.
     */
    function createWithTimestamps(
      store: ReturnType<typeof createSessionStore>,
      id: string,
      status: string,
      createdAt: string,
      updatedAt: string,
    ) {
      store.create({ id, workspacePath: `/w/${id}`, status: status as SessionStatus });
      db.prepare("UPDATE sessions SET created_at = @ca, updated_at = @ua WHERE id = @id").run({
        id,
        ca: createdAt,
        ua: updatedAt,
      });
    }

    it("sortBy=created, sortOrder=desc (default)", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "old", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "mid", "active", "2026-02-01 00:00:00", "2026-02-01 00:00:00");
      createWithTimestamps(store, "new", "active", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const rows = store.list();
      assert.deepEqual(
        rows.map((r) => r.id),
        ["new", "mid", "old"],
      );
    });

    it("sortBy=created, sortOrder=asc", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "old", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "new", "active", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const rows = store.list({ sortBy: "created", sortOrder: "asc" });
      assert.deepEqual(
        rows.map((r) => r.id),
        ["old", "new"],
      );
    });

    it("sortBy=lastActivity sorts by updated_at", () => {
      const store = createSessionStore(db);
      // "old" was created first but updated most recently
      createWithTimestamps(store, "old", "active", "2026-01-01 00:00:00", "2026-03-31 12:00:00");
      createWithTimestamps(store, "new", "active", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const rows = store.list({ sortBy: "lastActivity", sortOrder: "desc" });
      assert.equal(rows[0]!.id, "old", "most recently active should be first");
      assert.equal(rows[1]!.id, "new");
    });

    it("sortBy=name sorts by session id", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "charlie", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "alpha", "active", "2026-02-01 00:00:00", "2026-02-01 00:00:00");
      createWithTimestamps(store, "bravo", "active", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const asc = store.list({ sortBy: "name", sortOrder: "asc" });
      assert.deepEqual(
        asc.map((r) => r.id),
        ["alpha", "bravo", "charlie"],
      );

      const desc = store.list({ sortBy: "name", sortOrder: "desc" });
      assert.deepEqual(
        desc.map((r) => r.id),
        ["charlie", "bravo", "alpha"],
      );
    });

    it("limit restricts result count (applied after sort)", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "s1", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "s2", "active", "2026-02-01 00:00:00", "2026-02-01 00:00:00");
      createWithTimestamps(store, "s3", "active", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const rows = store.list({ sortBy: "created", sortOrder: "desc", limit: 1 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, "s3", "should return the newest session");
    });

    it("activeSince filters by updated_at (inclusive lower bound)", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "stale", "active", "2026-01-01 00:00:00", "2026-01-15 00:00:00");
      createWithTimestamps(store, "recent", "active", "2026-02-01 00:00:00", "2026-03-30 12:00:00");
      createWithTimestamps(store, "fresh", "active", "2026-03-01 00:00:00", "2026-03-31 06:00:00");

      const rows = store.list({ activeSince: "2026-03-01 00:00:00", sortBy: "lastActivity", sortOrder: "desc" });
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.id, "fresh");
      assert.equal(rows[1]!.id, "recent");
    });

    it("activeSince is inclusive (exact match included)", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "exact", "active", "2026-01-01 00:00:00", "2026-03-15 00:00:00");

      const rows = store.list({ activeSince: "2026-03-15 00:00:00" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, "exact");
    });

    it("activeSince + limit + sort compose correctly", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "a", "active", "2026-01-01 00:00:00", "2026-03-01 00:00:00");
      createWithTimestamps(store, "b", "active", "2026-02-01 00:00:00", "2026-03-15 00:00:00");
      createWithTimestamps(store, "c", "active", "2026-03-01 00:00:00", "2026-03-31 00:00:00");
      createWithTimestamps(store, "stale", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");

      // Active since March, newest first, limit 1 → should be "c"
      const rows = store.list({
        activeSince: "2026-03-01 00:00:00",
        sortBy: "lastActivity",
        sortOrder: "desc",
        limit: 1,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, "c");
    });

    it("activeSince with no matches returns empty array", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "old", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");

      const rows = store.list({ activeSince: "2026-12-01 00:00:00" });
      assert.equal(rows.length, 0);
    });

    it("status filter composes with sort and limit", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "a-active", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "b-active", "active", "2026-02-01 00:00:00", "2026-02-01 00:00:00");
      createWithTimestamps(store, "c-term", "terminated", "2026-03-01 00:00:00", "2026-03-01 00:00:00");

      const rows = store.list({
        status: "active" as SessionStatus,
        sortBy: "created",
        sortOrder: "asc",
        limit: 1,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, "a-active");
    });

    it("omitting all new params preserves default behavior (backward compat)", () => {
      const store = createSessionStore(db);
      createWithTimestamps(store, "x", "active", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
      createWithTimestamps(store, "y", "active", "2026-02-01 00:00:00", "2026-02-01 00:00:00");

      // Default: sortBy=created, sortOrder=desc → newest first
      const rows = store.list();
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.id, "y");
      assert.equal(rows[1]!.id, "x");
    });
  });
});
