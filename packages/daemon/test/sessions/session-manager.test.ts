import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { SHOGGOTH_AGENT_TOKEN_ENV } from "@shoggoth/authn";
import { formatAgentSessionUrn, parseAgentSessionUrn } from "@shoggoth/shared";
import type { ShoggothAgentsConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";

describe("createSessionManager", () => {
  it("spawn resolves platform from agentsConfig when no explicit platform given", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    const agentsConfig: ShoggothAgentsConfig = {
      list: {
        pytest: {
          platforms: {
            discord: { routes: [] },
          },
        },
      },
    };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "pytest",
      agentsConfig,
      mintToken: () => "fixed-test-token",
    });
    const out = await mgr.spawn({});
    assert.equal(out.agentTokenEnvName, SHOGGOTH_AGENT_TOKEN_ENV);
    assert.equal(out.agentToken, "fixed-test-token");
    assert.ok(parseAgentSessionUrn(out.sessionId));
    // Session URN should contain "discord" as the platform segment
    assert.ok(
      out.sessionId.includes(":discord:"),
      `expected discord in URN: ${out.sessionId}`,
    );
    assert.equal(agentTokens.validate("fixed-test-token", out.sessionId), true);
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row!.workspacePath, join(workspacesRoot, "pytest"));
    mgr.kill(out.sessionId);
    assert.equal(
      agentTokens.validate("fixed-test-token", out.sessionId),
      false,
    );
  });

  it("spawn with explicit platform uses it instead of agentsConfig", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    const agentsConfig: ShoggothAgentsConfig = {
      list: {
        myagent: {
          platforms: {
            discord: { routes: [] },
          },
        },
      },
    };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "myagent",
      agentsConfig,
      mintToken: () => "tok",
    });
    const out = await mgr.spawn({ platform: "control" });
    assert.ok(
      out.sessionId.includes(":control:"),
      `expected control in URN: ${out.sessionId}`,
    );
  });

  it("spawn throws ERR_NO_PLATFORM when no platform resolvable from agentsConfig", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "noplat",
      agentsConfig: { list: { noplat: {} } },
      mintToken: () => "tok",
    });
    await assert.rejects(
      () => mgr.spawn({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any) =>
        err.code === "ERR_NO_PLATFORM" && /platform bindings/.test(err.message),
    );
  });

  it("spawn with parentSessionId mints subagent URN and reuses parent agent workspace", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "parent",
      mintToken: () => "sub-session-token",
    });
    const parent = formatAgentSessionUrn(
      "parent",
      "discord",
      "channel",
      "20000000-0000-4000-8000-000000000001",
    );
    sessions.create({
      id: parent,
      workspacePath: join(workspacesRoot, "parent"),
      status: "active",
    });
    agentTokens.register(parent, "parent-raw");
    const out = await mgr.spawn({ parentSessionId: parent });
    const parsed = parseAgentSessionUrn(out.sessionId);
    assert.ok(parsed);
    assert.equal(parsed!.uuidChain.length, 2);
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row!.workspacePath, join(workspacesRoot, "parent"));
  });

  it("spawn resolves platform for a different agentId from agentsConfig", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    const agentsConfig: ShoggothAgentsConfig = {
      list: {
        main: {
          platforms: { discord: { routes: [] } },
        },
        secondary: {
          platforms: { slack: { routes: [] } },
        },
      },
    };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "main",
      agentsConfig,
      mintToken: () => "tok",
    });
    // Spawn for a different agent — should resolve platform from that agent's bindings
    const out = await mgr.spawn({ agentId: "secondary" });
    assert.ok(
      out.sessionId.includes(":slack:"),
      `expected slack in URN: ${out.sessionId}`,
    );
  });
});
