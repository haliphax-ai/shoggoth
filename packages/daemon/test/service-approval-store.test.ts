import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ServiceApprovalStore } from "../src/service-approval-store";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { closeTestDb } from "./helpers/close-test-db";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-service-approval-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("ServiceApprovalStore", () => {
  let store: ServiceApprovalStore;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const { db: database, dir } = openMigratedDb();
    db = database;
    tmpDir = dir;
    store = new ServiceApprovalStore(db);
  });

  afterEach(() => {
    closeTestDb(db, tmpDir);
  });

  describe("get", () => {
    it("should return null for non-existent service", () => {
      const result = store.get("non-existent");
      expect(result).toBeNull();
    });

    it("should return record after upsert", () => {
      store.upsert("service-1", "pending");
      const result = store.get("service-1");
      expect(result).not.toBeNull();
      expect(result?.serviceId).toBe("service-1");
      expect(result?.status).toBe("pending");
    });
  });

  describe("upsert", () => {
    it("should create new record with pending status", () => {
      store.upsert("new-service", "pending");
      const result = store.get("new-service");
      expect(result?.status).toBe("pending");
      expect(result?.approvedFingerprint).toBeNull();
    });

    it("should create record with fingerprint", () => {
      store.upsert("service-1", "approved", "abc123");
      const result = store.get("service-1");
      expect(result?.status).toBe("approved");
      expect(result?.approvedFingerprint).toBe("abc123");
    });

    it("should update existing record", () => {
      store.upsert("service-1", "pending");
      store.upsert("service-1", "approved", "fingerprint456");
      const result = store.get("service-1");
      expect(result?.status).toBe("approved");
      expect(result?.approvedFingerprint).toBe("fingerprint456");
    });
  });

  describe("approve", () => {
    it("should set status to approved and store fingerprint", () => {
      store.upsert("service-1", "pending");
      store.approve("service-1", "fingerprint789");
      const result = store.get("service-1");
      expect(result?.status).toBe("approved");
      expect(result?.approvedFingerprint).toBe("fingerprint789");
    });

    it("should work on non-existent service (create as approved)", () => {
      store.approve("new-service", "fingerprint");
      const result = store.get("new-service");
      expect(result?.status).toBe("approved");
      expect(result?.approvedFingerprint).toBe("fingerprint");
    });
  });

  describe("revoke", () => {
    it("should set status to revoked", () => {
      store.upsert("service-1", "approved", "fp");
      store.revoke("service-1");
      const result = store.get("service-1");
      expect(result?.status).toBe("revoked");
      expect(result?.approvedFingerprint).toBe("fp"); // fingerprint preserved
    });

    it("should work on non-existent service", () => {
      store.revoke("non-existent");
      const result = store.get("non-existent");
      expect(result?.status).toBe("revoked");
    });
  });

  describe("list", () => {
    beforeEach(() => {
      store.upsert("service-1", "pending");
      store.upsert("service-2", "approved", "fp1");
      store.upsert("service-3", "revoked");
      store.upsert("service-4", "pending-reapproval");
    });

    it("should list all records when no filter", () => {
      const results = store.list();
      expect(results).toHaveLength(4);
    });

    it("should filter by status", () => {
      const pending = store.list("pending");
      expect(pending).toHaveLength(2);
      expect(
        pending.every((r) => r.status === "pending" || r.status === "pending-reapproval"),
      ).toBe(true);

      const approved = store.list("approved");
      expect(approved).toHaveLength(1);
      expect(approved[0]?.serviceId).toBe("service-2");

      const revoked = store.list("revoked");
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.serviceId).toBe("service-3");
    });
  });

  describe("state transitions", () => {
    it("should transition from pending to approved", () => {
      store.upsert("service-1", "pending");
      store.approve("service-1", "fp");
      const result = store.get("service-1");
      expect(result?.status).toBe("approved");
    });

    it("should transition from approved to pending-reapproval on fingerprint mismatch", () => {
      store.upsert("service-1", "approved", "old-fp");
      store.upsert("service-1", "pending-reapproval", "new-fp");
      const result = store.get("service-1");
      expect(result?.status).toBe("pending-reapproval");
      expect(result?.approvedFingerprint).toBe("new-fp");
    });

    it("should transition from pending-reapproval to approved", () => {
      store.upsert("service-1", "pending-reapproval", "new-fp");
      store.approve("service-1", "new-fp");
      const result = store.get("service-1");
      expect(result?.status).toBe("approved");
    });

    it("should transition from any state to revoked", () => {
      store.upsert("service-1", "pending");
      store.revoke("service-1");
      expect(store.get("service-1")?.status).toBe("revoked");

      store.upsert("service-2", "approved", "fp");
      store.revoke("service-2");
      expect(store.get("service-2")?.status).toBe("revoked");

      store.upsert("service-3", "pending-reapproval", "fp");
      store.revoke("service-3");
      expect(store.get("service-3")?.status).toBe("revoked");
    });
  });

  describe("timestamps", () => {
    it("should set createdAt and updatedAt on create", () => {
      store.upsert("service-1", "pending");
      const result = store.get("service-1");
      expect(result?.createdAt).toBeDefined();
      expect(result?.updatedAt).toBeDefined();
    });

    it("should update updatedAt on status change", () => {
      store.upsert("service-1", "pending");
      const before = store.get("service-1")?.updatedAt;

      // Small delay to ensure different timestamp
      const beforeTime = Date.now();
      while (Date.now() === beforeTime) {}

      store.approve("service-1", "fp");
      const after = store.get("service-1")?.updatedAt;

      expect(after).not.toBe(before);
    });
  });
});
