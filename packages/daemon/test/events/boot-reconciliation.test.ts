import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createToolRunStore } from "../../src/sessions/tool-run-store";
import { claimPendingEvents, emitEvent, EVENT_SCOPE_GLOBAL, type EventQueueRow } from "../../src/events/events-queue";
import { runBootReconciliation } from "../../src/events/boot-reconciliation";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-boot-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("boot reconciliation", () => {
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

  it("requeues stale processing claims and fails orphaned tool runs", () => {
    emitEvent(db, { scope: EVENT_SCOPE_GLOBAL, eventType: "a", payload: {} });
    const [row] = claimPendingEvents(db, { limit: 1 }) as EventQueueRow[];
    const past = new Date(Date.now() - 300_000).toISOString();
    db.prepare("UPDATE events SET claimed_at = ? WHERE id = ?").run(past, row!.id);

    const sessions = createSessionStore(db);
    sessions.create({
      id: "sess1",
      workspacePath: "/tmp/w",
      status: "active",
    });
    const tools = createToolRunStore(db);
    tools.insertRunning({ id: "run1", sessionId: "sess1" });

    const r = runBootReconciliation(db, {
      staleClaimMs: 60_000,
      orphanedToolRunReason: "restart_reconciliation",
    });

    assert.equal(r.staleEventsRequeued, 1);
    assert.equal(r.toolRunsMarkedFailed, 1);

    const ev = db.prepare("SELECT status FROM events WHERE id = ?").get(row!.id) as { status: string };
    assert.equal(ev.status, "pending");

    const tr = db.prepare("SELECT status, failure_reason FROM tool_runs WHERE id = 'run1'").get() as {
      status: string;
      failure_reason: string | null;
    };
    assert.equal(tr.status, "failed");
    assert.equal(tr.failure_reason, "restart_reconciliation");
  });
});
