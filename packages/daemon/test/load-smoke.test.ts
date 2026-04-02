import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { emitEvent, EVENT_SCOPE_GLOBAL } from "../src/events/events-queue";

describe("load smoke — SQLite burst", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-smoke-"));
    dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath);
    migrate(db, defaultMigrationsDir());
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a burst of global events on one connection without loss", () => {
    const db = openStateDb(dbPath);
    migrate(db, defaultMigrationsDir());
    try {
      const n = 120;
      for (let i = 0; i < n; i++) {
        const r = emitEvent(db, {
          scope: EVENT_SCOPE_GLOBAL,
          eventType: "load-smoke",
          payload: { i },
          idempotencyKey: `smoke-${i}`,
        });
        assert.equal(r.ok, true);
      }
      const count = (
        db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = ?").get("load-smoke") as { c: number }
      ).c;
      assert.equal(count, n);
    } finally {
      db.close();
    }
  });

  it("rotates writes across multiple handles to the same DB without SQLITE_BUSY failure", () => {
    const handles: Database.Database[] = [];
    try {
      for (let h = 0; h < 3; h++) {
        const d = openStateDb(dbPath);
        migrate(d, defaultMigrationsDir());
        handles.push(d);
      }
      let failures = 0;
      for (let i = 0; i < 90; i++) {
        const db = handles[i % 3]!;
        try {
          const r = emitEvent(db, {
            scope: EVENT_SCOPE_GLOBAL,
            eventType: "load-smoke-mt",
            payload: { i },
            idempotencyKey: `mt-${i}`,
          });
          if (!r.ok) {
            failures++;
          }
        } catch {
          failures++;
        }
      }
      assert.equal(failures, 0, "no emit failures across concurrent DB handles");
      const count = (
        handles[0]!.prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = ?").get("load-smoke-mt") as {
          c: number;
        }
      ).c;
      assert.equal(count, 90);
    } finally {
      for (const d of handles) {
        d.close();
      }
    }
  });
});
