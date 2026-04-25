import { vi } from "vitest";

vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
}));

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, beforeEach, afterEach } from "vitest";
import { formatAgentSessionUrn } from "@shoggoth/shared";
import type { ShoggothAgentsConfig, ShoggothConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";

function makeDb() {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  return db;
}

const agentsConfig: ShoggothAgentsConfig = {
  list: {
    tester: {
      platforms: { discord: { routes: [] } },
    },
  },
};

describe("context level spawn wiring", () => {
  let db: Database.Database;
  let workspacesRoot: string;

  beforeEach(() => {
    db = makeDb();
    workspacesRoot = mkdtempSync(join(tmpdir(), "shoggoth-ctx-"));
  });

  afterEach(() => {
    closeTestDb(db, workspacesRoot);
  });

  it("spawn with explicit contextLevel override persists it on the session row", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = { agents: agentsConfig };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig,
      config,
      mintToken: () => "tok",
    });

    const out = await mgr.spawn({ contextLevel: "minimal" });
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "minimal");
  });

  it("spawn without override resolves default 'full' for top-level agent", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = { agents: agentsConfig };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig,
      config,
      mintToken: () => "tok",
    });

    const out = await mgr.spawn({});
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "full");
  });

  it("subagent spawn without override resolves default 'light'", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = { agents: agentsConfig };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig,
      config,
      mintToken: () => "tok",
    });

    // Create a parent session first
    const parent = formatAgentSessionUrn(
      "tester",
      "discord",
      "channel",
      "20000000-0000-4000-8000-000000000001",
    );
    sessions.create({
      id: parent,
      workspacePath: join(workspacesRoot, "tester"),
      status: "active",
    });
    agentTokens.register(parent, "parent-tok");

    const out = await mgr.spawn({ parentSessionId: parent });
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "light");
  });

  it("subagent spawn with explicit override uses the override", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = { agents: agentsConfig };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig,
      config,
      mintToken: () => "tok",
    });

    const parent = formatAgentSessionUrn(
      "tester",
      "discord",
      "channel",
      "20000000-0000-4000-8000-000000000002",
    );
    sessions.create({
      id: parent,
      workspacePath: join(workspacesRoot, "tester"),
      status: "active",
    });
    agentTokens.register(parent, "parent-tok");

    const out = await mgr.spawn({ parentSessionId: parent, contextLevel: "none" });
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "none");
  });

  it("per-agent config contextLevel is used when no spawn override", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = {
      agents: {
        ...agentsConfig,
        list: {
          ...agentsConfig.list,
          tester: {
            ...agentsConfig.list!.tester,
            contextLevel: "light",
          },
        },
      },
    };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig: config.agents,
      config,
      mintToken: () => "tok",
    });

    const out = await mgr.spawn({});
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "light");
  });

  it("spawn override takes precedence over per-agent config", async () => {
    const sessions = createSessionStore(db);
    const agentTokens = createSqliteAgentTokenStore(db);
    const config: ShoggothConfig = {
      agents: {
        ...agentsConfig,
        list: {
          ...agentsConfig.list,
          tester: {
            ...agentsConfig.list!.tester,
            contextLevel: "light",
          },
        },
      },
    };
    const mgr = createSessionManager({
      db,
      sessions,
      agentTokens,
      workspacesRoot,
      agentId: "tester",
      agentsConfig: config.agents,
      config,
      mintToken: () => "tok",
    });

    const out = await mgr.spawn({ contextLevel: "none" });
    const row = sessions.getById(out.sessionId);
    assert.ok(row);
    assert.equal(row.contextLevel, "none");
  });
});

describe("context level session store persistence", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    db = makeDb();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-ctx-store-"));
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("persists contextLevel on create and returns it on read", () => {
    const store = createSessionStore(db);
    store.create({
      id: "ctx-1",
      workspacePath: "/ws",
      status: "active",
      contextLevel: "minimal",
    });
    const row = store.getById("ctx-1");
    assert.ok(row);
    assert.equal(row.contextLevel, "minimal");
  });

  it("defaults contextLevel to undefined when not provided", () => {
    const store = createSessionStore(db);
    store.create({
      id: "ctx-2",
      workspacePath: "/ws",
      status: "active",
    });
    const row = store.getById("ctx-2");
    assert.ok(row);
    assert.equal(row.contextLevel, undefined);
  });

  it("updates contextLevel via update()", () => {
    const store = createSessionStore(db);
    store.create({
      id: "ctx-3",
      workspacePath: "/ws",
      status: "active",
      contextLevel: "full",
    });
    store.update("ctx-3", { contextLevel: "minimal" });
    const row = store.getById("ctx-3");
    assert.ok(row);
    assert.equal(row.contextLevel, "minimal");
  });

  it("clears contextLevel when updated to null", () => {
    const store = createSessionStore(db);
    store.create({
      id: "ctx-4",
      workspacePath: "/ws",
      status: "active",
      contextLevel: "light",
    });
    store.update("ctx-4", { contextLevel: null });
    const row = store.getById("ctx-4");
    assert.ok(row);
    assert.equal(row.contextLevel, undefined);
  });

  it("contextLevel survives list()", () => {
    const store = createSessionStore(db);
    store.create({
      id: "ctx-5",
      workspacePath: "/ws",
      status: "active",
      contextLevel: "none",
    });
    const rows = store.list();
    const row = rows.find((r) => r.id === "ctx-5");
    assert.ok(row);
    assert.equal(row.contextLevel, "none");
  });
});
