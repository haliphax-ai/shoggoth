/**
 * Unit tests for the re-read-required gate helpers.
 *
 * Covers:
 *   - mark + check round trip
 *   - segment scoping (flag from previous segment does not gate)
 *   - clear (single file, current segment only)
 *   - clearSession (all rows for a session, all segments)
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { closeTestDb } from "../helpers/close-test-db";
import {
  markReReadRequired,
  checkReReadRequired,
  clearReReadRequired,
  clearSessionReReadRequired,
} from "../../src/sessions/re-read-required";

describe("re-read-required", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-reread-"));
    const dbPath = join(tmp, "r.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
  await closeTestDb(db, tmp);
});

  it("mark then check returns a gate for the flagged file", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const gate = checkReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    assert.ok(gate, "gate should be present after marking");
    assert.equal(gate!.gated, true);
    assert.equal(gate!.filePath, "/ws/foo.ts");
    assert.match(gate!.message, /re-read/i);
  });

  it("check returns null for a different file in the same segment", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const gate = checkReReadRequired(db, "sess-a", "seg-1", "/ws/bar.ts");
    assert.equal(gate, null);
  });

  it("check is segment-scoped: a previous segment's flag does not gate", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const gate = checkReReadRequired(db, "sess-a", "seg-2", "/ws/foo.ts");
    assert.equal(gate, null);
  });

  it("check is session-scoped: another session's flag does not gate", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const gate = checkReReadRequired(db, "sess-b", "seg-1", "/ws/foo.ts");
    assert.equal(gate, null);
  });

  it("mark is idempotent within the same segment", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const row = db
      .prepare(
        "SELECT COUNT(*) as c FROM re_read_required WHERE session_id = ? AND context_segment_id = ? AND file_path = ?",
      )
      .get("sess-a", "seg-1", "/ws/foo.ts") as { c: number };
    assert.equal(row.c, 1);
  });

  it("clear removes the flag for the current segment", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    clearReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    const gate = checkReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    assert.equal(gate, null);
  });

  it("clear only affects the current segment", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    markReReadRequired(db, "sess-a", "seg-2", "/ws/foo.ts");
    clearReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    assert.equal(checkReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts"), null);
    assert.ok(
      checkReReadRequired(db, "sess-a", "seg-2", "/ws/foo.ts"),
      "seg-2 flag should survive clearing seg-1",
    );
  });

  it("clear is a no-op when there is no row to clear", () => {
    // Should not throw
    clearReReadRequired(db, "sess-a", "seg-1", "/ws/never-flagged.ts");
  });

  it("clearSession removes all rows for a session across all segments", () => {
    markReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts");
    markReReadRequired(db, "sess-a", "seg-2", "/ws/bar.ts");
    markReReadRequired(db, "sess-b", "seg-1", "/ws/baz.ts");
    clearSessionReReadRequired(db, "sess-a");
    assert.equal(checkReReadRequired(db, "sess-a", "seg-1", "/ws/foo.ts"), null);
    assert.equal(checkReReadRequired(db, "sess-a", "seg-2", "/ws/bar.ts"), null);
    assert.ok(
      checkReReadRequired(db, "sess-b", "seg-1", "/ws/baz.ts"),
      "another session's row must survive",
    );
  });
});
