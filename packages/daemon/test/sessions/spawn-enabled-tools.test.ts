// ---------------------------------------------------------------------------
// Spawn-time tool enables: enableToolsForSession + glob resolution at
// advertisement time (tool discovery finalizer).
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createAggregateMcpCatalogResult, type AggregatedTool } from "@shoggoth/mcp-integration";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  enableToolsForSession,
  getSessionToolState,
  isToolEnabledByState,
  setSessionToolState,
  createToolDiscoveryFinalizer,
} from "../../src/sessions/session-tool-discovery";
import type { SessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { openAiToolsFromCatalog } from "../../src/sessions/session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../../src/mcp/tool-loop-mcp";

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

function makeConfig(alwaysOn: string[]): ShoggothConfig {
  return {
    toolDiscovery: { enabled: true, alwaysOn, triggers: [] },
    agents: {},
  } as unknown as ShoggothConfig;
}

function tool(namespacedName: string): AggregatedTool {
  const [sourceId, ...rest] = namespacedName.split("-");
  const originalName = rest.join("-");
  return {
    name: originalName,
    namespacedName,
    sourceId,
    originalName,
    description: `stub ${namespacedName}`,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeCtx(toolIds: string[]): SessionMcpToolContext {
  const aggregated = createAggregateMcpCatalogResult(toolIds.map(tool));
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: undefined,
  };
}

const SESSION = "agent:test:discord:channel:parent:child";
const CATALOG = [
  "builtin-read",
  "builtin-exec",
  "builtin-discover",
  "builtin-elevate",
  "kanban-add-card",
  "kanban-list-boards",
  "lsp-find_symbol",
];

function advertisedIds(finalizer: ReturnType<typeof createToolDiscoveryFinalizer>): string[] {
  const out = finalizer(makeCtx(CATALOG), SESSION);
  return out.aggregated.tools.map((t) => t.namespacedName).sort();
}

describe("enableToolsForSession", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("records exact IDs and glob patterns as enabled entries", () => {
    enableToolsForSession(db, SESSION, ["builtin-exec", "kanban-*", " lsp-? "]);
    const state = getSessionToolState(db, SESSION);
    assert.equal(state.get("builtin-exec"), true);
    assert.equal(state.get("kanban-*"), true);
    assert.equal(state.get("lsp-?"), true);
  });

  it("skips blank entries", () => {
    enableToolsForSession(db, SESSION, ["", "   ", "builtin-read"]);
    const state = getSessionToolState(db, SESSION);
    assert.equal(state.size, 1);
    assert.equal(state.get("builtin-read"), true);
  });

  it("merges with pre-existing state rather than replacing it", () => {
    setSessionToolState(db, SESSION, "builtin-read", true);
    enableToolsForSession(db, SESSION, ["kanban-*"]);
    const state = getSessionToolState(db, SESSION);
    assert.equal(state.get("builtin-read"), true);
    assert.equal(state.get("kanban-*"), true);
  });
});

describe("isToolEnabledByState", () => {
  it("exact entries decide without consulting globs", () => {
    const state = new Map<string, boolean>([
      ["kanban-*", true],
      ["builtin-exec", false],
    ]);
    assert.equal(isToolEnabledByState("builtin-exec", state), false);
    assert.equal(isToolEnabledByState("kanban-add-card", state), true);
    assert.equal(isToolEnabledByState("lsp-find_symbol", state), false);
  });

  it("matches globs when no exact entry exists", () => {
    const state = new Map<string, boolean>([["lsp-*", true]]);
    assert.equal(isToolEnabledByState("lsp-find_symbol", state), true);
    assert.equal(isToolEnabledByState("lsp-replace_content", state), true);
    assert.equal(isToolEnabledByState("builtin-read", state), false);
  });
});

describe("tool discovery finalizer glob advertisement", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("enables only alwaysOn tools when no spawn-time enables exist", () => {
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["builtin-read"]), db);
    assert.deepEqual(advertisedIds(finalizer), [
      "builtin-discover",
      "builtin-elevate",
      "builtin-read",
    ]);
  });

  it("glob spawn-time enables advertise every matching catalog tool", () => {
    enableToolsForSession(db, SESSION, ["kanban-*"]);
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["builtin-read"]), db);
    assert.deepEqual(advertisedIds(finalizer), [
      "builtin-discover",
      "builtin-elevate",
      "builtin-read",
      "kanban-add-card",
      "kanban-list-boards",
    ]);
  });

  it("exact spawn-time enables advertise just that tool", () => {
    enableToolsForSession(db, SESSION, ["lsp-find_symbol"]);
    const finalizer = createToolDiscoveryFinalizer(makeConfig([]), db);
    assert.deepEqual(advertisedIds(finalizer), [
      "builtin-discover",
      "builtin-elevate",
      "lsp-find_symbol",
    ]);
  });

  it("exact disable wins over an enabled glob", () => {
    enableToolsForSession(db, SESSION, ["builtin-*"]);
    setSessionToolState(db, SESSION, "builtin-exec", false);
    const finalizer = createToolDiscoveryFinalizer(makeConfig([]), db);
    const ids = advertisedIds(finalizer);
    assert.ok(ids.includes("builtin-read"));
    assert.ok(!ids.includes("builtin-exec"));
  });
});
