// ---------------------------------------------------------------------------
// Phantom alwaysOn entries: configured `toolDiscovery.alwaysOn` IDs that match
// no tool in the aggregated catalog (e.g. after an MCP server rename) must be
// diagnosable instead of silently "working" in `builtin-discover list`.
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createAggregateMcpCatalogResult, type AggregatedTool } from "@shoggoth/mcp-integration";
import type { ShoggothConfig } from "@shoggoth/shared";
import { createLogger, setRootLogger, type Logger, type LogFields } from "@shoggoth/shared";
import {
  createToolDiscoveryFinalizer,
  setSessionToolState,
  toolCatalogCache,
  toolRefreshNeeded,
} from "../../src/sessions/session-tool-discovery";
import type { SessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import { openAiToolsFromCatalog } from "../../src/sessions/session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../../src/mcp/tool-loop-mcp";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerDiscover } from "../../src/sessions/builtin-handlers/discover-handler";

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
    fullAggregated: aggregated,
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

const defaultLogger = createLogger({ component: "shoggoth" });

function makeRecordingLogger(): {
  logger: Logger;
  warns: Array<{ msg: string; fields?: LogFields }>;
} {
  const warns: Array<{ msg: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => warns.push({ msg, fields }),
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

function stubCtx(
  db: Database.Database,
  config: ShoggothConfig,
  overrides: Partial<BuiltinToolContext> = {},
): BuiltinToolContext {
  return {
    sessionId: SESSION,
    db,
    config,
    env: {},
    workspacePath: "/tmp",
    workspaceRealPath: "/tmp",
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
// Discovery finalizer: warn on configured alwaysOn IDs that match nothing
// ---------------------------------------------------------------------------

describe("phantom alwaysOn discovery finalizer warning", () => {
  let db: Database.Database;
  let warns: Array<{ msg: string; fields?: LogFields }>;
  const sids: string[] = [];

  beforeEach(() => {
    db = makeTestDb();
    const recording = makeRecordingLogger();
    warns = recording.warns;
    setRootLogger(recording.logger);
  });

  afterEach(() => {
    for (const sid of sids) toolCatalogCache.delete(sid);
    sids.length = 0;
    setRootLogger(defaultLogger);
    db.close();
  });

  it("warns listing configured alwaysOn IDs that match no catalog tool", () => {
    const sid = "agent:test:discord:channel:phantom-fw-1";
    sids.push(sid);
    const finalizer = createToolDiscoveryFinalizer(
      makeConfig(["hash-hashline_read", "builtin-read"]),
      db,
    );
    finalizer(makeCtx(CATALOG), sid);

    const warn = warns.find((w) => w.msg === "tool_discovery.alwaysOn_unmatched");
    assert.ok(warn, "expected an alwaysOn_unmatched warning");
    assert.equal(warn.fields?.sessionId, sid);
    const unmatched = warn.fields?.unmatched as string[];
    assert.deepEqual([...unmatched].sort(), ["hash-hashline_read"]);
  });

  it("warns once per session for the same unmatched ID", () => {
    const sid = "agent:test:discord:channel:phantom-fw-2";
    sids.push(sid);
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["hash-hashline_read"]), db);
    finalizer(makeCtx(CATALOG), sid);
    finalizer(makeCtx(CATALOG), sid);
    assert.equal(warns.filter((w) => w.msg === "tool_discovery.alwaysOn_unmatched").length, 1);
  });

  it("does not warn when every exact alwaysOn entry matches the catalog", () => {
    const sid = "agent:test:discord:channel:phantom-fw-3";
    sids.push(sid);
    const finalizer = createToolDiscoveryFinalizer(makeConfig(["builtin-read"]), db);
    finalizer(makeCtx(CATALOG), sid);
    assert.equal(
      warns.find((w) => w.msg === "tool_discovery.alwaysOn_unmatched"),
      undefined,
    );
  });

  it("globs never count as unmatched", () => {
    const sid = "agent:test:discord:channel:phantom-fw-4";
    sids.push(sid);
    const finalizer = createToolDiscoveryFinalizer(
      makeConfig(["kanban-*", "hash-hashline_read"]),
      db,
    );
    finalizer(makeCtx(CATALOG), sid);
    const warn = warns.find((w) => w.msg === "tool_discovery.alwaysOn_unmatched");
    assert.ok(warn, "expected an alwaysOn_unmatched warning");
    assert.deepEqual(warn.fields?.unmatched, ["hash-hashline_read"]);
  });
});

// ---------------------------------------------------------------------------
// builtin-discover list: phantom rows must not masquerade as real tools
// ---------------------------------------------------------------------------

describe("phantom alwaysOn discover list rows", () => {
  let db: Database.Database;
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    db = makeTestDb();
    registry = new BuiltinToolRegistry();
    registerDiscover(registry);
  });

  afterEach(() => {
    toolCatalogCache.delete(SESSION);
    db.close();
  });

  it("fallback omits configured-only rows instead of listing them as available", async () => {
    setSessionToolState(db, SESSION, "builtin-subagent", true);
    toolCatalogCache.delete(SESSION);

    const result = await registry.execute(
      "discover",
      { list: true },
      stubCtx(db, makeConfig(["hash-hashline_read"])),
    );
    const parsed = JSON.parse(result.resultJson);

    // No descriptions are available, so nothing can be verified as a real
    // tool: the catalog must be empty rather than masquerading stale IDs.
    assert.deepEqual(parsed.catalog, []);
  });

  it("catalog-backed list output never contains rows for tools outside the catalog", async () => {
    toolCatalogCache.set(SESSION, new Map([["builtin-read", "stub builtin-read"]]));

    const result = await registry.execute(
      "discover",
      { list: true },
      stubCtx(db, makeConfig(["hash-hashline_read"])),
    );
    const parsed = JSON.parse(result.resultJson);

    const ids = parsed.catalog.map((t: { id: string }) => t.id);
    assert.ok(ids.includes("builtin-read"));
    assert.ok(!ids.includes("hash-hashline_read"), "no phantom row when the catalog is known");
  });
});

// ---------------------------------------------------------------------------
// Mid-loop enables of tools absent from the advertised catalog
// ---------------------------------------------------------------------------

describe("phantom alwaysOn mid-loop refresh", () => {
  let db: Database.Database;
  let registry: BuiltinToolRegistry;
  let warns: Array<{ msg: string; fields?: LogFields }>;

  beforeEach(() => {
    db = makeTestDb();
    registry = new BuiltinToolRegistry();
    registerDiscover(registry);
    const recording = makeRecordingLogger();
    warns = recording.warns;
    setRootLogger(recording.logger);
  });

  afterEach(() => {
    toolCatalogCache.delete(SESSION);
    toolRefreshNeeded.delete(SESSION);
    setRootLogger(defaultLogger);
    db.close();
  });

  it("enabling a tool that is absent from the advertised catalog warns once per enable", async () => {
    toolCatalogCache.set(SESSION, new Map([["builtin-read", "stub builtin-read"]]));

    const result = await registry.execute(
      "discover",
      { enable: ["builtin-lspx", "builtin-read"] },
      stubCtx(db, makeConfig([])),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.deepEqual(parsed.applied.enabled, ["builtin-lspx", "builtin-read"]);

    const warn = warns.find((w) => w.msg === "tool_discovery.enable_unmatched");
    assert.ok(warn, "expected an enable_unmatched warning");
    assert.equal(warn.fields?.sessionId, SESSION);
    assert.deepEqual(warn.fields?.ids, ["builtin-lspx"]);

    // Repeat enable of the same unmatched ID must not spam warnings.
    warns.length = 0;
    await registry.execute("discover", { enable: ["builtin-lspx"] }, stubCtx(db, makeConfig([])));
    assert.equal(
      warns.find((w) => w.msg === "tool_discovery.enable_unmatched"),
      undefined,
    );
  });

  it("does not warn when enabled tools are all advertised", async () => {
    toolCatalogCache.set(
      SESSION,
      new Map([
        ["builtin-read", "stub builtin-read"],
        ["builtin-exec", "stub builtin-exec"],
      ]),
    );

    await registry.execute("discover", { enable: ["builtin-exec"] }, stubCtx(db, makeConfig([])));
    assert.equal(
      warns.find((w) => w.msg === "tool_discovery.enable_unmatched"),
      undefined,
    );
  });

  it("skips the advertised check when no catalog snapshot exists", async () => {
    toolCatalogCache.delete(SESSION);

    await registry.execute("discover", { enable: ["builtin-lspx"] }, stubCtx(db, makeConfig([])));
    assert.equal(
      warns.find((w) => w.msg === "tool_discovery.enable_unmatched"),
      undefined,
    );
  });
});
