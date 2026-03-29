import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-hitl-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("PendingActionsStore", () => {
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

  it("enqueue and getById round-trip", () => {
    const store = createPendingActionsStore(db);
    const id = store.enqueue({
      id: "p1",
      sessionId: "sess-a",
      toolName: "exec",
      payload: { argv: ["ls"] },
      riskTier: "critical",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
      correlationId: "corr-1",
      resourceSummary: "/workspace",
    });
    assert.equal(id, "p1");
    const row = store.getById("p1");
    assert.ok(row);
    assert.equal(row!.status, "pending");
    assert.equal(row!.toolName, "exec");
    assert.equal(row!.sessionId, "sess-a");
    assert.deepEqual(row!.payload, { argv: ["ls"] });
  });

  it("approve resolves pending", () => {
    const store = createPendingActionsStore(db);
    store.enqueue({
      id: "p2",
      sessionId: "s",
      toolName: "write",
      payload: {},
      riskTier: "caution",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    const ok = store.approve("p2", "op-1");
    assert.equal(ok, true);
    const row = store.getById("p2");
    assert.equal(row!.status, "approved");
    assert.equal(row!.resolverPrincipal, "op-1");
    assert.ok(row!.resolvedAt);
  });

  it("deny resolves pending with operator reason", () => {
    const store = createPendingActionsStore(db);
    store.enqueue({
      id: "p3",
      sessionId: "s",
      toolName: "exec",
      payload: {},
      riskTier: "critical",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(store.deny("p3", "op-x"), true);
    const row = store.getById("p3");
    assert.equal(row!.status, "denied");
    assert.equal(row!.denialReason, "operator");
  });

  it("approve returns false for unknown id", () => {
    const store = createPendingActionsStore(db);
    assert.equal(store.approve("nope", "op"), false);
  });

  it("expireDue marks overdue pending as denied with timeout", () => {
    const store = createPendingActionsStore(db);
    store.enqueue({
      id: "old",
      sessionId: "s",
      toolName: "write",
      payload: {},
      riskTier: "caution",
      expiresAtIso: "2020-01-01T00:00:00.000Z",
    });
    const n = store.expireDue("2025-01-01T00:00:00.000Z");
    assert.equal(n, 1);
    const row = store.getById("old");
    assert.equal(row!.status, "denied");
    assert.equal(row!.denialReason, "timeout");
  });

  it("listAllPending returns pending rows capped", () => {
    const store = createPendingActionsStore(db);
    store.enqueue({
      id: "all-a",
      sessionId: "s1",
      toolName: "read",
      payload: {},
      riskTier: "safe",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    store.enqueue({
      id: "all-b",
      sessionId: "s2",
      toolName: "write",
      payload: {},
      riskTier: "caution",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    const all = store.listAllPending(10);
    assert.equal(all.length, 2);
  });

  it("hooks fire on approve, deny, and expireDue", () => {
    const events: string[] = [];
    const store = createPendingActionsStore(db, {
      hooks: {
        onResolved: ({ id, status, denialReason }) => {
          events.push(`${id}:${status}:${denialReason ?? ""}`);
        },
      },
    });
    store.enqueue({
      id: "h1",
      sessionId: "s",
      toolName: "read",
      payload: {},
      riskTier: "safe",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    store.approve("h1", "op");
    store.enqueue({
      id: "h2",
      sessionId: "s",
      toolName: "read",
      payload: {},
      riskTier: "safe",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    store.deny("h2", "op");
    store.enqueue({
      id: "h3",
      sessionId: "s",
      toolName: "read",
      payload: {},
      riskTier: "safe",
      expiresAtIso: "2020-01-01T00:00:00.000Z",
    });
    store.expireDue("2025-01-01T00:00:00.000Z");
    assert.deepEqual(events, [
      "h1:approved:",
      "h2:denied:operator",
      "h3:denied:timeout",
    ]);
  });

  it("listPendingForSession returns only pending", () => {
    const store = createPendingActionsStore(db);
    store.enqueue({
      id: "a",
      sessionId: "sx",
      toolName: "read",
      payload: {},
      riskTier: "safe",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    store.enqueue({
      id: "b",
      sessionId: "sx",
      toolName: "write",
      payload: {},
      riskTier: "caution",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });
    store.approve("a", "op");
    const pending = store.listPendingForSession("sx");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, "b");
  });
});
