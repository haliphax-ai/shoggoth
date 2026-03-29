import { describe, it } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteAcpxBindingStore } from "../../src/acpx/sqlite-acpx-bindings";

describe("sqlite-acpx-bindings", () => {
  it("upserts and lists acpx workspace bindings", () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO sessions (id, workspace_path, status) VALUES (?, ?, ?)`,
    ).run("sess-a", "/w", "active");

    const store = createSqliteAcpxBindingStore(db);
    store.upsert({
      acpWorkspaceRoot: "/acp/w1",
      shoggothSessionId: "sess-a",
      agentPrincipalId: "agent-1",
    });

    const one = store.get("/acp/w1");
    assert.ok(one);
    assert.strictEqual(one!.shoggothSessionId, "sess-a");

    assert.strictEqual(store.delete("/missing"), false);
    assert.strictEqual(store.delete("/acp/w1"), true);
    assert.strictEqual(store.get("/acp/w1"), undefined);

    store.upsert({
      acpWorkspaceRoot: "/acp/w2",
      shoggothSessionId: "sess-a",
      agentPrincipalId: "agent-2",
    });
    assert.strictEqual(store.list().length, 1);

    db.close();
  });
});
