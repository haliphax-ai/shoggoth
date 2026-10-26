import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createElevationStore } from "../../src/elevation/elevation-store";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { closeTestDb } from "../helpers/close-test-db";

function insertGrant(
  db: Database.Database,
  id: string,
  sessionId: string,
  expiresAt: string,
  revoked = false,
): void {
  db.prepare(
    `INSERT INTO elevation_grants (id, session_id, granted_at, expires_at, revoked)
     VALUES (@id, @sessionId, @grantedAt, @expiresAt, @revoked)`,
  ).run({
    id,
    sessionId,
    grantedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    revoked: revoked ? 1 : 0,
  });
}

describe("elevation store", () => {
  let db: Database.Database;
  let tmpDir: string;
  const session = "agent:main:discord:channel:elev-test";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shoggoth-elevation-"));
    db = openStateDb(join(tmpDir, "test.db"));
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    await closeTestDb(db, tmpDir);
  });

  describe("revoke", () => {
    it("revokes an active grant", () => {
      const store = createElevationStore(db);
      const grant = store.grant(session);
      expect(store.revoke(grant.id)).toBe(true);
      expect(store.isActive(session)).toBe(false);
    });

    it("does not count an expired grant as revoked", () => {
      insertGrant(db, "expired-1", session, new Date(Date.now() - 1000).toISOString());
      const store = createElevationStore(db);
      expect(store.revoke("expired-1")).toBe(false);
    });
  });

  describe("revokeAllForSession", () => {
    it("counts only active grants", () => {
      insertGrant(db, "active-1", session, new Date(Date.now() + 60_000).toISOString());
      insertGrant(db, "expired-1", session, new Date(Date.now() - 1000).toISOString());
      insertGrant(db, "revoked-1", session, new Date(Date.now() + 60_000).toISOString(), true);
      const store = createElevationStore(db);
      expect(store.revokeAllForSession(session)).toBe(1);
    });

    it("returns 0 when only expired grants remain", () => {
      insertGrant(db, "expired-2", session, new Date(Date.now() - 1000).toISOString());
      const store = createElevationStore(db);
      expect(store.revokeAllForSession(session)).toBe(0);
    });
  });

  describe("list", () => {
    it("returns only active, non-revoked grants", () => {
      insertGrant(db, "active-2", session, new Date(Date.now() + 60_000).toISOString());
      insertGrant(db, "expired-3", session, new Date(Date.now() - 1000).toISOString());
      insertGrant(db, "revoked-2", session, new Date(Date.now() + 60_000).toISOString(), true);
      const store = createElevationStore(db);
      const grants = store.list(session);
      expect(grants.map((g) => g.id)).toEqual(["active-2"]);
    });

    it("lists active grants across sessions when no filter is given", () => {
      insertGrant(db, "active-a", "agent:main:a", new Date(Date.now() + 60_000).toISOString());
      insertGrant(db, "active-b", "agent:main:b", new Date(Date.now() + 60_000).toISOString());
      insertGrant(db, "expired-4", "agent:main:c", new Date(Date.now() - 1000).toISOString());
      const store = createElevationStore(db);
      const grants = store.list();
      expect(grants.map((g) => g.id).sort()).toEqual(["active-a", "active-b"]);
    });

    it("returns an empty list when there are no active grants", () => {
      const store = createElevationStore(db);
      expect(store.list()).toEqual([]);
    });
  });
});
