import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ServiceKeyStore } from "../src/service-key-store";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { closeTestDb } from "./helpers/close-test-db";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-service-keys-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("ServiceKeyStore", () => {
  let store: ServiceKeyStore;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const { db: database, dir } = openMigratedDb();
    db = database;
    tmpDir = dir;
    store = new ServiceKeyStore(db);
  });

  afterEach(() => {
    closeTestDb(db, tmpDir);
  });

  describe("generateIdentity", () => {
    it("should return identity and recipient where recipient starts with 'age1'", async () => {
      const result = await store.generateIdentity("service-1");
      expect(result).toHaveProperty("identity");
      expect(result).toHaveProperty("recipient");
      expect(result.identity).toBeTruthy();
      expect(result.recipient).toMatch(/^age1/);
    });

    it("should throw or replace on duplicate generateIdentity for same serviceId", async () => {
      await store.generateIdentity("service-1");
      // Second call for same serviceId should either throw or replace
      await expect(store.generateIdentity("service-1")).rejects.toThrow();
    });
  });

  describe("getRecipient", () => {
    it("should return stored recipient after generate", async () => {
      const { recipient } = await store.generateIdentity("service-1");
      const result = store.getRecipient("service-1");
      expect(result).toBe(recipient);
    });

    it("should return null for unknown service", () => {
      const result = store.getRecipient("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("getFingerprint", () => {
    it("should return first 16 chars of recipient", async () => {
      const { recipient } = await store.generateIdentity("service-1");
      const fingerprint = store.getFingerprint("service-1");
      expect(fingerprint).toBe(recipient.slice(0, 16));
    });

    it("should return null for unknown service", () => {
      const result = store.getFingerprint("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("rotateIdentity", () => {
    it("should return new identity and recipient", async () => {
      const original = await store.generateIdentity("service-1");
      const rotated = await store.rotateIdentity("service-1");
      expect(rotated).toHaveProperty("identity");
      expect(rotated).toHaveProperty("recipient");
      expect(rotated.recipient).toMatch(/^age1/);
      expect(rotated.recipient).not.toBe(original.recipient);
    });

    it("should make old recipient no longer returned by getRecipient", async () => {
      const original = await store.generateIdentity("service-1");
      const rotated = await store.rotateIdentity("service-1");
      const current = store.getRecipient("service-1");
      expect(current).toBe(rotated.recipient);
      expect(current).not.toBe(original.recipient);
    });
  });

  describe("deleteIdentity", () => {
    it("should remove the key", async () => {
      await store.generateIdentity("service-1");
      store.deleteIdentity("service-1");
      expect(store.getRecipient("service-1")).toBeNull();
      expect(store.hasIdentity("service-1")).toBe(false);
    });
  });

  describe("hasIdentity", () => {
    it("should return false for unknown service", () => {
      expect(store.hasIdentity("non-existent")).toBe(false);
    });

    it("should return true after generateIdentity", async () => {
      await store.generateIdentity("service-1");
      expect(store.hasIdentity("service-1")).toBe(true);
    });

    it("should return false after deleteIdentity", async () => {
      await store.generateIdentity("service-1");
      store.deleteIdentity("service-1");
      expect(store.hasIdentity("service-1")).toBe(false);
    });
  });
});
