import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import {
  markProviderFailed,
  clearProviderFailure,
  getProviderFailure,
  isProviderFailed,
} from "../../src/sessions/provider-failure-store";

const TMP = join(import.meta.dirname ?? ".", ".tmp-provider-failure-test");

function openTestDb(): Database.Database {
  mkdirSync(TMP, { recursive: true });
  const db = new Database(join(TMP, "test.db"));
  migrate(db, defaultMigrationsDir());
  return db;
}

describe("provider-failure-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    closeTestDb(db, TMP);
  });

  describe("getProviderFailure", () => {
    it("returns null for unknown provider", () => {
      assert.strictEqual(getProviderFailure(db, "unknown"), null);
    });

    it("returns failure record after markProviderFailed", () => {
      markProviderFailed(db, "openai", "rate limit");
      const f = getProviderFailure(db, "openai");
      assert.ok(f);
      assert.ok(f.failedAt instanceof Date);
      assert.strictEqual(f.error, "rate limit");
      assert.strictEqual(f.retryCount, 1);
    });

    it("returns failure with no error when none provided", () => {
      markProviderFailed(db, "openai");
      const f = getProviderFailure(db, "openai");
      assert.ok(f);
      assert.strictEqual(f.error, undefined);
      assert.strictEqual(f.retryCount, 1);
    });
  });

  describe("markProviderFailed", () => {
    it("increments retryCount on repeated failures", () => {
      markProviderFailed(db, "anthropic", "err1");
      markProviderFailed(db, "anthropic", "err2");
      markProviderFailed(db, "anthropic", "err3");
      const f = getProviderFailure(db, "anthropic");
      assert.ok(f);
      assert.strictEqual(f.retryCount, 3);
      assert.strictEqual(f.error, "err3");
    });

    it("updates failedAt on each call", () => {
      markProviderFailed(db, "openai", "first");
      const f1 = getProviderFailure(db, "openai");
      assert.ok(f1);

      markProviderFailed(db, "openai", "second");
      const f2 = getProviderFailure(db, "openai");
      assert.ok(f2);
      assert.ok(f2.failedAt.getTime() >= f1.failedAt.getTime());
    });

    it("tracks separate providers independently", () => {
      markProviderFailed(db, "openai", "err-a");
      markProviderFailed(db, "anthropic", "err-b");
      const a = getProviderFailure(db, "openai");
      const b = getProviderFailure(db, "anthropic");
      assert.ok(a);
      assert.ok(b);
      assert.strictEqual(a.error, "err-a");
      assert.strictEqual(b.error, "err-b");
    });
  });

  describe("clearProviderFailure", () => {
    it("removes a failure record", () => {
      markProviderFailed(db, "openai", "boom");
      clearProviderFailure(db, "openai");
      assert.strictEqual(getProviderFailure(db, "openai"), null);
    });

    it("is a no-op for unknown provider", () => {
      clearProviderFailure(db, "nonexistent");
    });
  });

  describe("isProviderFailed", () => {
    it("returns false for unknown provider", () => {
      assert.strictEqual(isProviderFailed(db, "openai", 60_000), false);
    });

    it("returns true when failure is within duration", () => {
      markProviderFailed(db, "openai", "down");
      assert.strictEqual(isProviderFailed(db, "openai", 60_000), true);
    });

    it("returns false and clears stale failure", () => {
      db.prepare(
        `INSERT OR REPLACE INTO provider_failures (provider_id, failed_at, error, retry_count)
         VALUES (@providerId, datetime('now', '-120 seconds'), @error, 1)`,
      ).run({ providerId: "openai", error: "old" });

      assert.strictEqual(isProviderFailed(db, "openai", 60_000), false);
      assert.strictEqual(getProviderFailure(db, "openai"), null);
    });

    it("returns true when failure is not yet stale", () => {
      db.prepare(
        `INSERT OR REPLACE INTO provider_failures (provider_id, failed_at, error, retry_count)
         VALUES (@providerId, datetime('now', '-10 seconds'), @error, 1)`,
      ).run({ providerId: "openai", error: "recent" });

      assert.strictEqual(isProviderFailed(db, "openai", 60_000), true);
      assert.ok(getProviderFailure(db, "openai"));
    });
  });
});
