/**
 * RED-phase TDD tests for per-agent MCP pool scope (Phase 3).
 *
 * These tests verify:
 * 1. Two sessions with the same agent ID share one per-agent pool.
 * 2. Two sessions with different agent IDs get separate per-agent pools.
 * 3. Agent credentials (agentContext) are passed through to connectShoggothMcpServers.
 * 4. Fallback: unparseable session URN falls back to the global pool.
 * 5. shutdown() closes all per-agent pools.
 * 6. Three-tier context merging: global + per-agent + per-session tools are merged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionMcpRuntime } from "../../src/sessions/session-mcp-runtime";
import type { McpServerPool } from "../../src/mcp/mcp-server-pool";
import type { ConnectShoggothMcpPoolOptions } from "../../src/mcp/mcp-server-pool";
import type { ShoggothConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import { defaultConfig, formatAgentSessionUrn } from "@shoggoth/shared";
import type { McpSourceCatalog } from "@shoggoth/mcp-integration";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal per-agent MCP server entry (stdio, poolScope per_agent). */
function perAgentServer(id = "agent-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "per_agent",
  } as ShoggothMcpServerEntry;
}

/** Minimal global MCP server entry. */
function globalServer(id = "global-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "global",
  } as ShoggothMcpServerEntry;
}

/** Minimal per-session MCP server entry. */
function perSessionServer(id = "session-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "per_session",
  } as ShoggothMcpServerEntry;
}

/** Build a config with the given MCP servers. */
function configWithServers(
  workspacePath: string,
  servers: ShoggothMcpServerEntry[],
): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = {
    ...cfg.mcp,
    servers,
    poolScope: "global",
  };
  return cfg;
}

/** Fake MCP source catalog for a given server id. */
function fakeSourceCatalog(serverId: string): McpSourceCatalog {
  return {
    sourceId: serverId,
    tools: [
      {
        name: `${serverId}-tool`,
        description: `Tool from ${serverId}`,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
}

/**
 * Creates a mock `connectShoggothMcpServers` that tracks connect/close calls
 * and the options (including agentContext) passed to each call.
 */
function createMockConnectMcp() {
  const connectCalls: {
    serverIds: string[];
    options: ConnectShoggothMcpPoolOptions | undefined;
  }[] = [];
  const closeFns: ReturnType<typeof vi.fn>[] = [];

  const connectShoggothMcpServers = vi.fn(
    async (servers: readonly ShoggothMcpServerEntry[], options?: ConnectShoggothMcpPoolOptions) => {
      const serverIds = servers.map((s) => s.id);
      connectCalls.push({ serverIds, options });
      const closeFn = vi.fn(async () => {});
      closeFns.push(closeFn);

      const externalSources: McpSourceCatalog[] = servers.map((s) => fakeSourceCatalog(s.id));

      const pool: McpServerPool = {
        externalSources,
        close: closeFn,
      };
      return {
        pool,
        external: vi.fn(async () => ({ resultJson: "{}" })),
      };
    },
  );

  return { connectShoggothMcpServers, connectCalls, closeFns };
}

/** Format two session URNs for the same agent. */
function sessionsForAgent(agentId: string): [string, string] {
  return [
    formatAgentSessionUrn(agentId, "discord", "channel", "aaaaaaaa-0000-4000-8000-000000000001"),
    formatAgentSessionUrn(agentId, "discord", "channel", "aaaaaaaa-0000-4000-8000-000000000002"),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-agent MCP pool scope", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-per-agent-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    closeTestDb(db, tmp);
  });

  // -----------------------------------------------------------------------
  // 1. Two sessions with the same agent ID share one per-agent pool
  // -----------------------------------------------------------------------
  it("two sessions with the same agent ID share one per-agent pool", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess1, sess2] = sessionsForAgent("myagent");

    // Resolve context for two different sessions belonging to the same agent
    const ctx1 = await runtime.resolveContext(sess1);
    const ctx2 = await runtime.resolveContext(sess2);

    // The per-agent MCP servers should have been connected only ONCE
    // (both sessions share the same agent pool).
    const perAgentConnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnects).toHaveLength(1);

    // Both contexts should include the per-agent tool
    expect(ctx1.aggregated.tools.some((t) => t.sourceId === "agent-mcp")).toBe(true);
    expect(ctx2.aggregated.tools.some((t) => t.sourceId === "agent-mcp")).toBe(true);

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 2. Two sessions with different agent IDs get separate per-agent pools
  // -----------------------------------------------------------------------
  it("two sessions with different agent IDs get separate per-agent pools", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sessAlpha] = sessionsForAgent("alpha");
    const [sessBeta] = sessionsForAgent("beta");

    await runtime.resolveContext(sessAlpha);
    await runtime.resolveContext(sessBeta);

    // Each agent should trigger its own connect call for per-agent servers
    const perAgentConnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnects).toHaveLength(2);

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 3. Agent credentials (agentContext) are passed through
  // -----------------------------------------------------------------------
  it("connectShoggothMcpServers receives correct agentContext for per-agent pool", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const agentId = "credtest";
    const [sess] = sessionsForAgent(agentId);

    await runtime.resolveContext(sess);

    // The per-agent connect call should include agentContext with uid, gid, workspacePath
    const perAgentConnect = mockMcp.connectCalls.find((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnect).toBeDefined();
    expect(perAgentConnect!.options?.agentContext).toBeDefined();
    expect(perAgentConnect!.options!.agentContext!.workspacePath).toContain(agentId);
    expect(typeof perAgentConnect!.options!.agentContext!.uid).toBe("number");
    expect(typeof perAgentConnect!.options!.agentContext!.gid).toBe("number");

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 4. Fallback: unparseable session URN uses global pool
  // -----------------------------------------------------------------------
  it("falls back to global pool when agent ID cannot be parsed from session URN", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [globalServer(), perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Use a session ID that is NOT a valid agent URN
    const badSessionId = "not-a-valid-urn";

    const ctx = await runtime.resolveContext(badSessionId);

    // Should NOT have created a per-agent pool for the bad URN
    const perAgentConnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnects).toHaveLength(0);

    // Should still have global tools available
    expect(ctx.aggregated.tools.some((t) => t.sourceId === "global-mcp")).toBe(true);

    // Per-agent tools should NOT be present (no per-agent pool was created)
    expect(ctx.aggregated.tools.some((t) => t.sourceId === "agent-mcp")).toBe(false);

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 5. shutdown() closes all per-agent pools
  // -----------------------------------------------------------------------
  it("shutdown closes all per-agent pools", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Create pools for two different agents
    const [sessAlpha] = sessionsForAgent("alpha");
    const [sessBeta] = sessionsForAgent("beta");

    await runtime.resolveContext(sessAlpha);
    await runtime.resolveContext(sessBeta);

    // Identify the close functions for per-agent pools
    const perAgentCloseIndices = mockMcp.connectCalls
      .map((c, i) => (c.serverIds.includes("agent-mcp") ? i : -1))
      .filter((i) => i >= 0);

    expect(perAgentCloseIndices).toHaveLength(2);

    // Before shutdown, close should not have been called
    for (const idx of perAgentCloseIndices) {
      expect(mockMcp.closeFns[idx]).not.toHaveBeenCalled();
    }

    await runtime.shutdown();

    // After shutdown, all per-agent pool close functions should have been called
    for (const idx of perAgentCloseIndices) {
      expect(mockMcp.closeFns[idx]).toHaveBeenCalledOnce();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Three-tier context merging: global + per-agent + per-session
  // -----------------------------------------------------------------------
  it("resolveContext merges tools from global + per-agent + per-session sources", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [
      globalServer("global-mcp"),
      perAgentServer("agent-mcp"),
      perSessionServer("session-mcp"),
    ]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("mergetest");

    const ctx = await runtime.resolveContext(sess);

    // The resolved context should contain tools from all three tiers
    const sourceIds = new Set(
      ctx.aggregated.tools.filter((t) => t.sourceId !== "builtin").map((t) => t.sourceId),
    );

    expect(sourceIds.has("global-mcp")).toBe(true);
    expect(sourceIds.has("agent-mcp")).toBe(true);
    expect(sourceIds.has("session-mcp")).toBe(true);

    // The external invoke should route to the correct pool for each source
    expect(ctx.external).toBeDefined();

    await runtime.shutdown();
  });
});
