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
 * 7. Per-agent idle eviction — after notifyTurnEnd with no subsequent turn, agent pool evicted.
 * 8. Per-agent idle eviction — notifyTurnBegin cancels pending per-agent idle timer.
 * 9. Per-agent idle eviction — two sessions sharing agent pool: eviction only when both idle.
 * 10. shutdown() clears per-agent idle timers.
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

// ---------------------------------------------------------------------------
// 7–10. Per-agent idle eviction (Phase 5)
// ---------------------------------------------------------------------------

/** Build a config with per-agent servers and a short idle timeout. */
function configWithPerAgentIdleTimeout(
  workspacePath: string,
  servers: ShoggothMcpServerEntry[],
  idleMs = 5000,
): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = {
    ...cfg.mcp,
    servers,
    poolScope: "global",
    perInstanceIdleTimeoutMs: idleMs,
  };
  return cfg;
}

describe("per-agent MCP pool idle eviction", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-per-agent-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeTestDb(db, tmp);
  });

  // -----------------------------------------------------------------------
  // 7. Per-agent idle eviction — notifyTurnEnd evicts agent pool after timeout
  // -----------------------------------------------------------------------
  it("notifyTurnEnd with no subsequent notifyTurnBegin evicts the per-agent pool after timeout", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerAgentIdleTimeout(tmp, [perAgentServer()], idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("idle-agent");

    // Resolve context to trigger the per-agent pool connect
    await runtime.resolveContext(sess);
    const perAgentConnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnects).toHaveLength(1);

    // End turn — should schedule per-agent idle timer
    runtime.notifyTurnEnd(sess);

    // Advance past the idle timeout
    vi.advanceTimersByTime(idleMs + 100);

    // The per-agent pool should have been evicted (close called).
    // This FAILS because the current runtime does not schedule idle eviction for per-agent pools.
    const perAgentCloseIdx = mockMcp.connectCalls.findIndex((c) =>
      c.serverIds.includes("agent-mcp"),
    );
    expect(mockMcp.closeFns[perAgentCloseIdx]).toHaveBeenCalled();

    // Resolving context again should trigger a fresh per-agent connect
    await runtime.resolveContext(sess);
    const perAgentConnects2 = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(perAgentConnects2).toHaveLength(2);

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 8. Per-agent idle eviction — notifyTurnBegin cancels pending timer
  // -----------------------------------------------------------------------
  it("notifyTurnBegin cancels a pending per-agent idle timer", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerAgentIdleTimeout(tmp, [perAgentServer()], idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("cancel-agent");

    await runtime.resolveContext(sess);

    // End turn → schedules per-agent idle timer
    runtime.notifyTurnEnd(sess);

    // Advance partway
    vi.advanceTimersByTime(idleMs - 1000);

    // Begin a new turn → should cancel the per-agent idle timer.
    // This FAILS because notifyTurnBegin only cancels per-session timers currently.
    runtime.notifyTurnBegin(sess);

    // Advance well past the original timeout
    vi.advanceTimersByTime(idleMs * 2);

    // Per-agent pool should NOT have been evicted
    const perAgentCloseIdx = mockMcp.connectCalls.findIndex((c) =>
      c.serverIds.includes("agent-mcp"),
    );
    expect(mockMcp.closeFns[perAgentCloseIdx]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 9. Two sessions sharing agent pool: eviction only when both idle
  // -----------------------------------------------------------------------
  it("two sessions sharing per-agent pool: eviction only fires when all sessions for that agent are idle", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerAgentIdleTimeout(tmp, [perAgentServer()], idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess1, sess2] = sessionsForAgent("shared-agent");

    await runtime.resolveContext(sess1);
    await runtime.resolveContext(sess2);

    // End turn for sess1
    runtime.notifyTurnEnd(sess1);

    // Advance partway
    vi.advanceTimersByTime(idleMs - 1000);

    // sess2 starts a turn — should keep the per-agent pool alive.
    // This FAILS because the runtime doesn't track per-agent idle across sessions.
    runtime.notifyTurnBegin(sess2);

    // Advance past original timeout
    vi.advanceTimersByTime(idleMs * 2);

    // Per-agent pool should NOT have been evicted (sess2 is still active)
    const perAgentCloseIdx = mockMcp.connectCalls.findIndex((c) =>
      c.serverIds.includes("agent-mcp"),
    );
    expect(mockMcp.closeFns[perAgentCloseIdx]).not.toHaveBeenCalled();

    // Now end sess2's turn
    runtime.notifyTurnEnd(sess2);

    // Advance past timeout
    vi.advanceTimersByTime(idleMs + 100);

    // NOW the per-agent pool should be evicted
    expect(mockMcp.closeFns[perAgentCloseIdx]).toHaveBeenCalled();

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 10. shutdown() clears per-agent idle timers
  // -----------------------------------------------------------------------
  it("shutdown clears per-agent idle timers so eviction callback does not fire", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerAgentIdleTimeout(tmp, [perAgentServer()], idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("shutdown-agent");

    await runtime.resolveContext(sess);

    // End turn — schedules per-agent idle timer
    runtime.notifyTurnEnd(sess);

    // Shutdown before the timer fires — should clear the timer.
    // This FAILS because shutdown() doesn't clear per-agent idle timers (they don't exist yet).
    await runtime.shutdown();

    // Advance past the timeout — the eviction callback should NOT fire
    vi.advanceTimersByTime(idleMs * 2);

    // The pool was closed by shutdown, but the idle eviction callback should not
    // have fired (no double-close or errors from stale timer).
    // close is called once by shutdown, not again by the timer.
    const perAgentCloseIdx = mockMcp.connectCalls.findIndex((c) =>
      c.serverIds.includes("agent-mcp"),
    );
    expect(mockMcp.closeFns[perAgentCloseIdx]).toHaveBeenCalledTimes(1);
  });
});
