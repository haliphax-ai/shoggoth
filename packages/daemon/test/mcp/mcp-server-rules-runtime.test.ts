/**
 * Phase 4 — MCP server allow/deny runtime filtering.
 *
 * These tests verify that `createSessionMcpRuntime` respects `McpServerRules`
 * when building the `SessionMcpToolContext`:
 *   1. Denied servers' tools are excluded from `resolveContext`.
 *   2. `ExternalMcpInvoke` rejects calls targeting a denied `sourceId`.
 *   3. Re-enabling a previously denied server makes its tools visible again.
 *
 * All tests mock `connectShoggothMcpServers` so no real MCP processes are needed.
 * They should FAIL until the filtering logic is wired into `session-mcp-runtime.ts`.
 */
import assert from "node:assert";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import {
  defaultConfig,
  formatAgentSessionUrn,
  type ShoggothConfig,
  type ShoggothMcpServerEntry,
} from "@shoggoth/shared";
import type { McpSourceCatalog } from "@shoggoth/mcp-integration";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import {
  createSessionMcpRuntime,
  type SessionMcpRuntime,
} from "../../src/sessions/session-mcp-runtime";
import type { ExternalMcpInvoke } from "../../src/mcp/tool-loop-mcp";
import type { McpServerPool } from "../../src/mcp/mcp-server-pool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  return db;
}

/** Fake MCP source catalog for a server with one tool. */
function fakeSourceCatalog(serverId: string, toolName: string): McpSourceCatalog {
  return {
    sourceId: serverId,
    tools: [
      {
        name: toolName,
        description: `Tool from ${serverId}`,
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  };
}

/**
 * Build a mock `connectShoggothMcpServers` that returns pre-built catalogs
 * and records invocations for assertions.
 */
function mockConnectMcp(catalogs: McpSourceCatalog[]) {
  const invokeCalls: { sourceId: string; originalName: string }[] = [];
  let closed = false;

  const external: ExternalMcpInvoke = async ({ sourceId, originalName }) => {
    invokeCalls.push({ sourceId, originalName });
    return { resultJson: JSON.stringify({ ok: true, sourceId, originalName }) };
  };

  const pool: McpServerPool = {
    externalSources: catalogs,
    close: async () => {
      closed = true;
    },
  };

  const connect = async () => ({ pool, external });

  return { connect, invokeCalls, isClosed: () => closed };
}

/** Minimal valid config with two MCP servers and optional serverRules. */
function buildConfig(overrides?: Partial<ShoggothConfig>): ShoggothConfig {
  const base = defaultConfig("/tmp/test-config");
  return {
    ...base,
    mcp: {
      servers: [
        {
          id: "allowed-server",
          transport: "stdio",
          command: "true",
        } as ShoggothMcpServerEntry,
        {
          id: "denied-server",
          transport: "stdio",
          command: "true",
        } as ShoggothMcpServerEntry,
      ],
      poolScope: "global",
    },
    ...overrides,
  } as ShoggothConfig;
}

const SESSION_ID = formatAgentSessionUrn(
  "main",
  "test",
  "channel",
  "00000000-0000-4000-8000-000000000001",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server rules — runtime filtering", () => {
  let runtime: SessionMcpRuntime | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = undefined;
    db?.close();
    db = undefined;
  });

  // ── 1. resolveContext filters denied servers ──────────────────────────

  it("resolveContext excludes tools from a denied MCP server", async () => {
    const catalogs = [
      fakeSourceCatalog("allowed-server", "good-tool"),
      fakeSourceCatalog("denied-server", "bad-tool"),
    ];
    const mock = mockConnectMcp(catalogs);
    db = makeDb();

    const config = buildConfig({
      mcp: {
        servers: [
          {
            id: "allowed-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
          {
            id: "denied-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
        ],
        poolScope: "global",
        serverRules: { allow: ["*"], deny: ["denied-server"] },
      },
    });

    runtime = await createSessionMcpRuntime({
      config,
      env: {},
      db,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { connectShoggothMcpServers: mock.connect as any },
    });

    const ctx = await runtime.resolveContext(SESSION_ID);

    // The denied server's tool should NOT appear
    const externalTools = ctx.aggregated.tools.filter((t) => t.sourceId !== "builtin");
    const sourceIds = new Set(externalTools.map((t) => t.sourceId));

    assert.ok(sourceIds.has("allowed-server"), "allowed-server tools should be present");
    assert.ok(!sourceIds.has("denied-server"), "denied-server tools should be filtered out");
    assert.ok(
      externalTools.some((t) => t.namespacedName === "allowed-server-good-tool"),
      "allowed-server-good-tool should be in the catalog",
    );
    assert.ok(
      !externalTools.some((t) => t.namespacedName === "denied-server-bad-tool"),
      "denied-server-bad-tool should NOT be in the catalog",
    );
  });

  // ── 2. ExternalMcpInvoke rejects denied sourceId ─────────────────────

  it("ExternalMcpInvoke returns mcp_server_denied for a denied server", async () => {
    const catalogs = [
      fakeSourceCatalog("allowed-server", "good-tool"),
      fakeSourceCatalog("denied-server", "bad-tool"),
    ];
    const mock = mockConnectMcp(catalogs);
    db = makeDb();

    const config = buildConfig({
      mcp: {
        servers: [
          {
            id: "allowed-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
          {
            id: "denied-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
        ],
        poolScope: "global",
        serverRules: { allow: ["*"], deny: ["denied-server"] },
      },
    });

    runtime = await createSessionMcpRuntime({
      config,
      env: {},
      db,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { connectShoggothMcpServers: mock.connect as any },
    });

    const ctx = await runtime.resolveContext(SESSION_ID);

    // The external invoke should reject calls to the denied server
    assert.ok(ctx.external, "external invoke should be defined");
    const result = await ctx.external!({
      sourceId: "denied-server",
      originalName: "bad-tool",
      argsJson: "{}",
      toolCallId: "call-1",
    });

    const parsed = JSON.parse(result.resultJson);
    assert.equal(
      parsed.error,
      "mcp_server_denied",
      "invoke to denied server should return mcp_server_denied error",
    );
    assert.equal(parsed.sourceId, "denied-server");

    // The mock's external should NOT have been called for the denied server
    assert.ok(
      !mock.invokeCalls.some((c) => c.sourceId === "denied-server"),
      "denied server invoke should not reach the underlying MCP session",
    );
  });

  // ── 3. Re-enabling a denied server ───────────────────────────────────

  it("re-enabling a previously denied server includes its tools on next resolveContext", async () => {
    const catalogs = [
      fakeSourceCatalog("allowed-server", "good-tool"),
      fakeSourceCatalog("denied-server", "bad-tool"),
    ];
    const mock = mockConnectMcp(catalogs);
    db = makeDb();

    // Start with denied-server blocked
    const config = buildConfig({
      mcp: {
        servers: [
          {
            id: "allowed-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
          {
            id: "denied-server",
            transport: "stdio",
            command: "true",
          } as ShoggothMcpServerEntry,
        ],
        poolScope: "global",
        serverRules: { allow: ["*"], deny: ["denied-server"] },
      },
    });

    runtime = await createSessionMcpRuntime({
      config,
      env: {},
      db,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps: { connectShoggothMcpServers: mock.connect as any },
    });

    // First resolve — denied-server should be absent
    const ctx1 = await runtime.resolveContext(SESSION_ID);
    const ext1 = ctx1.aggregated.tools.filter((t) => t.sourceId !== "builtin");
    assert.ok(
      !ext1.some((t) => t.sourceId === "denied-server"),
      "denied-server should be absent initially",
    );

    // Simulate dynamic config change: remove the deny rule
    // The plan says "rules are resolved per-call, not cached" so mutating config
    // should take effect on the next resolveContext call.
    config.mcp!.serverRules = { allow: ["*"], deny: [] };

    // Second resolve — denied-server should now appear
    const ctx2 = await runtime.resolveContext(SESSION_ID);
    const ext2 = ctx2.aggregated.tools.filter((t) => t.sourceId !== "builtin");
    assert.ok(
      ext2.some((t) => t.sourceId === "denied-server"),
      "denied-server should appear after removing deny rule",
    );
    assert.ok(
      ext2.some((t) => t.namespacedName === "denied-server-bad-tool"),
      "denied-server-bad-tool should be in the catalog after re-enable",
    );
  });
});
