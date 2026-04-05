// ---------------------------------------------------------------------------
// builtin-discover reset feature tests (TDD)
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerDiscover } from "../../src/sessions/builtin-handlers/discover-handler";
import {
  getSessionToolState,
  setSessionToolState,
} from "../../src/sessions/session-tool-discovery";
import type { ShoggothConfig } from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tool_state (
      session_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (session_id, tool_id)
    )
  `);
  return db;
}

function makeConfig(alwaysOn: string[] = []): ShoggothConfig {
  return {
    toolDiscovery: {
      enabled: true,
      alwaysOn,
      triggers: [],
    },
    agents: {},
  } as unknown as ShoggothConfig;
}

function stubCtx(
  db: Database.Database,
  config: ShoggothConfig,
  overrides: Partial<BuiltinToolContext> = {},
): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    db,
    config,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RED: Reset feature tests (these will fail until implemented)
// ---------------------------------------------------------------------------

describe("builtin-discover reset action", () => {
  let db: Database.Database;
  let config: ShoggothConfig;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    db = makeTestDb();
    config = makeConfig(["builtin-read", "builtin-write"]);
    registry = new BuiltinToolRegistry();
    registerDiscover(registry);
  });

  afterEach(() => {
    db.close();
  });

  it("should accept reset: true parameter", async () => {
    const ctx = stubCtx(db, config);
    const result = await registry.execute("discover", { reset: true }, ctx);
    const parsed = JSON.parse(result.resultJson);
    
    // Should not error
    assert.strictEqual(parsed.error, undefined);
    // Should indicate reset was applied
    assert.strictEqual(parsed.applied.reset, true);
  });

  it("should clear all session tool state on reset", async () => {
    const sessionId = "agent:test:discord:channel:123";
    
    // Enable some tools first
    setSessionToolState(db, sessionId, "builtin-subagent", true);
    setSessionToolState(db, sessionId, "builtin-workflow", true);
    setSessionToolState(db, sessionId, "builtin-search-replace", true);
    
    // Verify they're enabled
    let state = getSessionToolState(db, sessionId);
    assert.strictEqual(state.get("builtin-subagent"), true);
    assert.strictEqual(state.get("builtin-workflow"), true);
    assert.strictEqual(state.get("builtin-search-replace"), true);
    
    // Reset
    const ctx = stubCtx(db, config);
    await registry.execute("discover", { reset: true }, ctx);
    
    // Verify state is cleared
    state = getSessionToolState(db, sessionId);
    assert.strictEqual(state.has("builtin-subagent"), false);
    assert.strictEqual(state.has("builtin-workflow"), false);
    assert.strictEqual(state.has("builtin-search-replace"), false);
  });

  it("should not affect alwaysOn tools after reset", async () => {
    const ctx = stubCtx(db, config);
    
    // Reset with list
    const result = await registry.execute("discover", { reset: true, list: true }, ctx);
    const parsed = JSON.parse(result.resultJson);
    
    // alwaysOn tools should still show as enabled
    const readTool = parsed.catalog.find((t: { id: string }) => t.id === "builtin-read");
    const writeTool = parsed.catalog.find((t: { id: string }) => t.id === "builtin-write");
    
    assert.strictEqual(readTool?.enabled, true);
    assert.strictEqual(readTool?.alwaysOn, true);
    assert.strictEqual(writeTool?.enabled, true);
    assert.strictEqual(writeTool?.alwaysOn, true);
  });

  it("should signal tool refresh needed after reset", async () => {
    const ctx = stubCtx(db, config);
    
    // Import the refresh signal map
    const { toolRefreshNeeded } = await import("../../src/sessions/session-tool-discovery");
    toolRefreshNeeded.delete(ctx.sessionId);
    
    await registry.execute("discover", { reset: true }, ctx);
    
    assert.strictEqual(toolRefreshNeeded.get(ctx.sessionId), true);
  });

  it("should work with reset combined with enable", async () => {
    const sessionId = "agent:test:discord:channel:123";
    
    // Enable some tools first
    setSessionToolState(db, sessionId, "builtin-workflow", true);
    setSessionToolState(db, sessionId, "builtin-search-replace", true);
    
    // Reset and enable a different tool
    const ctx = stubCtx(db, config);
    const result = await registry.execute(
      "discover",
      { reset: true, enable: ["builtin-subagent"] },
      ctx,
    );
    const parsed = JSON.parse(result.resultJson);
    
    // Should show reset and enable both applied
    assert.strictEqual(parsed.applied.reset, true);
    assert.deepStrictEqual(parsed.applied.enabled, ["builtin-subagent"]);
    
    // Verify state
    const state = getSessionToolState(db, sessionId);
    assert.strictEqual(state.get("builtin-subagent"), true);
    assert.strictEqual(state.has("builtin-workflow"), false);
    assert.strictEqual(state.has("builtin-search-replace"), false);
  });

  it("should return error when tool discovery is disabled", async () => {
    const disabledConfig: ShoggothConfig = {
      toolDiscovery: {
        enabled: false,
        alwaysOn: [],
        triggers: [],
      },
      agents: {},
    } as unknown as ShoggothConfig;
    
    const ctx = stubCtx(db, disabledConfig);
    const result = await registry.execute("discover", { reset: true }, ctx);
    const parsed = JSON.parse(result.resultJson);
    
    assert.strictEqual(parsed.error, "tool discovery is not enabled");
  });
});