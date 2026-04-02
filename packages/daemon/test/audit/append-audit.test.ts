import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { appendAuditRow } from "../../src/audit/append-audit";

describe("appendAuditRow", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("inserts plugin load rows", () => {
    dir = mkdtempSync(join(tmpdir(), "sh-audit-"));
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath);
    migrate(db, defaultMigrationsDir());

    appendAuditRow(db, {
      source: "system",
      principalKind: "system",
      principalId: "plugin-loader",
      action: "plugin.load",
      resource: "demo",
      outcome: "success",
    });

    const row = db
      .prepare(
        `SELECT source, action, resource, outcome FROM audit_log ORDER BY id DESC LIMIT 1`,
      )
      .get() as { source: string; action: string; resource: string; outcome: string };

    assert.strictEqual(row.source, "system");
    assert.strictEqual(row.action, "plugin.load");
    assert.strictEqual(row.resource, "demo");
    assert.strictEqual(row.outcome, "success");
    db.close();
  });
});
