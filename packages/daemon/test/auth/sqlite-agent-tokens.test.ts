import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { mintAgentCredentialRaw } from "@shoggoth/authn";

function openMigratedDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  return db;
}

describe("createSqliteAgentTokenStore", () => {
  it("registers hash and validates for active session", () => {
    const db = openMigratedDb();
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    sessions.create({ id: "s1", workspacePath: "/w", status: "active" });
    const raw = mintAgentCredentialRaw();
    tokens.register("s1", raw);
    assert.strictEqual(tokens.validate(raw, "s1"), true);
    assert.strictEqual(tokens.validate(raw, "other"), false);
  });

  it("denies when session is terminated", () => {
    const db = openMigratedDb();
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    sessions.create({ id: "s2", workspacePath: "/w", status: "active" });
    const raw = mintAgentCredentialRaw();
    tokens.register("s2", raw);
    sessions.update("s2", { status: "terminated" });
    assert.strictEqual(tokens.validate(raw, "s2"), false);
  });

  it("replaces prior token for same session on re-register", () => {
    const db = openMigratedDb();
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    sessions.create({ id: "s3", workspacePath: "/w", status: "active" });
    const oldRaw = mintAgentCredentialRaw();
    const newRaw = mintAgentCredentialRaw();
    tokens.register("s3", oldRaw);
    tokens.register("s3", newRaw);
    assert.strictEqual(tokens.validate(oldRaw, "s3"), false);
    assert.strictEqual(tokens.validate(newRaw, "s3"), true);
  });
});
