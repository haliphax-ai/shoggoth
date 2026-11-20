// ---------------------------------------------------------------------------
// Config-side alwaysOn defaults: glob patterns in global toolDiscovery.alwaysOn
// and per-agent toolDiscovery.alwaysOn (subagent defaults).
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createAggregateMcpCatalogResult, type AggregatedTool } from "@shoggoth/mcp-integration";
import type { ShoggothConfig } from "@shoggoth/shared";
import {
  isAlwaysOnTool,
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

function makeConfig(alwaysOn: string[], perAgentAlwaysOn?: string[]): ShoggothConfig {
  return {
    toolDiscovery: { enabled: true, alwaysOn, triggers: [] },
    agents: {
      list: perAgentAlwaysOn
        ? { developer: { toolDiscovery: { alwaysOn: perAgentAlwaysOn } } }
        : {},
    },
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

describe("isAlwaysOnTool", () => {
  it("matches exact set membership", () => {
    const alwaysOn = new Set(["builtin-read"]);
    assert.equal(isAlwaysOnTool("builtin-read", alwaysOn), true);
    assert.equal(isAlwaysOnTool("builtin-exec", alwaysOn), false);
  });

  it("matches glob entries", () => {
    const alwaysOn = new Set(["kanban-*"]);
    assert.equal(isAlwaysOnTool("kanban-add-card", alwaysOn), true);
    assert.equal(isAlwaysOnTool("kanban-list-boards", alwaysOn), true);
    assert.equal(isAlwaysOnTool("lsp-find_symbol", alwaysOn), false);
  });

  it("misses when neither an exact entry nor a glob applies", () => {
    const alwaysOn = new Set(["builtin-read", "kanban-*"]);
    assert.equal(isAlwaysOnTool("lsp-find_symbol", alwaysOn), false);
    assert.equal(isAlwaysOnTool("kanbanxadd-card", alwaysOn), false);
  });
});

describe("alwaysOn glob advertisement", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("config alwaysOn globs advertise every matching catalog tool", () => {
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["kanban-*"]), db);
    assert.deepEqual(advertisedIds(finalizer), [
      "builtin-discover",
      "builtin-elevate",
      "kanban-add-card",
      "kanban-list-boards",
    ]);
  });

  it("exact alwaysOn entries still work alongside implicit defaults", () => {
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["builtin-read"]), db);
    assert.deepEqual(advertisedIds(finalizer), [
      "builtin-discover",
      "builtin-elevate",
      "builtin-read",
    ]);
  });

  it("non-matching globs advertise nothing beyond the implicit defaults", () => {
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["nope-*"]), db);
    assert.deepEqual(advertisedIds(finalizer), ["builtin-discover", "builtin-elevate"]);
  });

  it("per-agent alwaysOn globs (subagent defaults) apply to that agent's sessions", () => {
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["builtin-read"], ["lsp-*"]), db);
    const ids = finalizer(makeCtx(CATALOG), "agent:developer:discord:channel:1");
    assert.deepEqual(ids.aggregated.tools.map((t) => t.namespacedName).sort(), [
      "builtin-discover",
      "builtin-elevate",
      "builtin-read",
      "lsp-find_symbol",
    ]);
  });
});
