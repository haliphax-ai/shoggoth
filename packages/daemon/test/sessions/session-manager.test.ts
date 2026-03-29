import assert from "node:assert";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";
import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";

describe("createSessionManager", () => {
  it("spawn mints credential, persists hash, and kill revokes", () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      mintToken: () => "fixed-test-token",
    });
    const out = mgr.spawn({ workspacePath: "/tmp/ws" });
    assert.strictEqual(out.agentTokenEnvName, SHOGGOTH_AGENT_TOKEN_ENV);
    assert.strictEqual(out.agentToken, "fixed-test-token");
    assert.strictEqual(agentTokens.validate("fixed-test-token", out.sessionId), true);
    mgr.kill(out.sessionId);
    assert.strictEqual(agentTokens.validate("fixed-test-token", out.sessionId), false);
  });
});
