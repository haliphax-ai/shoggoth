/**
 * Session MCP runtime — dead-pool recovery:
 *  - a pool whose server has died (hasLiveServers false) is evicted from the
 *    per-agent / per-session / global caches and reconnected on the next
 *    resolveContext, with circuits re-armed (explicit recovery)
 *  - dependent per-session entries for the agent are dropped with it
 *  - a live pool keeps its cache (no reconnect churn)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionMcpRuntime } from "../../src/sessions/session-mcp-runtime";
import type { McpServerPool } from "../../src/mcp/mcp-server-pool";
import type { ConnectShoggothMcpPoolOptions } from "../../src/mcp/mcp-server-pool";
import type {
  ShoggothConfig,
  ShoggothMcpServerBody,
  ShoggothMcpServerEntry,
} from "@shoggoth/shared";
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

function perAgentServer(id = "agent-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "per_agent",
  } as ShoggothMcpServerEntry;
}

function globalServer(id = "global-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "global",
  } as ShoggothMcpServerEntry;
}

function perSessionServer(id = "session-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "per_session",
  } as ShoggothMcpServerEntry;
}

function configWithServers(
  workspacePath: string,
  servers: ShoggothMcpServerEntry[],
): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  const keyed: Record<string, ShoggothMcpServerBody> = {};
  for (const { id, ...body } of servers) keyed[id] = body;
  cfg.mcp = {
    ...cfg.mcp,
    servers: keyed,
    poolScope: "global",
  };
  return cfg;
}

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
 * Mock `connectShoggothMcpServers` whose pools can be "killed" by test code:
 * each connect returns a pool with a mutable `dead` flag that flips
 * hasLiveServers/isServerLive.
 */
function createKillableMockConnectMcp() {
  const connectCalls: {
    serverIds: string[];
    options: ConnectShoggothMcpPoolOptions | undefined;
    pool: KillablePool;
  }[] = [];
  const closeFns: ReturnType<typeof vi.fn>[] = [];

  type KillablePool = McpServerPool & { dead: boolean };

  const connectShoggothMcpServers = vi.fn(
    async (servers: readonly ShoggothMcpServerEntry[], options?: ConnectShoggothMcpPoolOptions) => {
      const serverIds = servers.map((s) => s.id);
      const closeFn = vi.fn(async () => {});
      closeFns.push(closeFn);

      const externalSources: McpSourceCatalog[] = servers.map((s) => fakeSourceCatalog(s.id));

      const pool: KillablePool = {
        externalSources,
        dead: false,
        hasLiveServers: () => !pool.dead,
        isServerLive: () => !pool.dead,
        close: closeFn,
      };
      connectCalls.push({ serverIds, options, pool });

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

describe("session MCP runtime — dead pool recovery", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-restart-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  it("a dead per-agent pool is evicted and reconnected on the next resolveContext", async () => {
    const mockMcp = createKillableMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("death-agent");

    // First resolve connects the per-agent pool.
    await runtime.resolveContext(sess);
    expect(mockMcp.connectCalls).toHaveLength(1);

    // Server dies (pool reports dead).
    mockMcp.connectCalls[0]!.pool.dead = true;

    // Next resolve must NOT trust the stale cache: fresh connect, circuits re-armed.
    const ctx2 = await runtime.resolveContext(sess);
    expect(mockMcp.connectCalls).toHaveLength(2);
    expect(
      mockMcp.connectCalls[1]!.options?.rearmCircuits,
      "recovery connect must re-arm circuits",
    ).toBe(true);
    expect(ctx2.aggregated.tools.some((t) => t.sourceId === "agent-mcp")).toBe(true);

    // A third resolve on the (now live) pool must NOT reconnect again.
    await runtime.resolveContext(sess);
    expect(mockMcp.connectCalls).toHaveLength(2);

    await runtime.shutdown();
  });

  it("dependent per-session pools are dropped when the agent pool dies", async () => {
    const mockMcp = createKillableMockConnectMcp();
    const config = configWithServers(tmp, [globalServer(), perAgentServer(), perSessionServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess1] = sessionsForAgent("cascade-agent");

    await runtime.resolveContext(sess1);
    // Connects: 1 global (at runtime creation), 1 per-agent, 1 per-session.
    const initialCount = mockMcp.connectCalls.length;
    expect(initialCount).toBeGreaterThanOrEqual(3);

    // Kill ONLY the per-agent pool.
    const agentPoolCall = mockMcp.connectCalls.find((c) => c.serverIds.includes("agent-mcp"));
    agentPoolCall!.pool.dead = true;

    // Next resolve: per-agent reconnects AND the stale per-session snapshot is rebuilt.
    await runtime.resolveContext(sess1);
    const agentReconnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("agent-mcp"));
    expect(agentReconnects.length).toBe(2);
    // The per-session pool must also have been reconnected (its snapshot was
    // dropped with the agent pool).
    const sessionConnects = mockMcp.connectCalls.filter((c) => c.serverIds.includes("session-mcp"));
    expect(sessionConnects.length).toBe(2);

    await runtime.shutdown();
  });

  it("a live pool does not trigger reconnect churn", async () => {
    const mockMcp = createKillableMockConnectMcp();
    const config = configWithServers(tmp, [perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("stable-agent");

    await runtime.resolveContext(sess);
    await runtime.resolveContext(sess);
    await runtime.resolveContext(sess);

    expect(mockMcp.connectCalls).toHaveLength(1);
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("a dead global pool reconnects on the next resolveContext", async () => {
    const mockMcp = createKillableMockConnectMcp();
    const config = configWithServers(tmp, [globalServer(), perAgentServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const [sess] = sessionsForAgent("global-death");

    await runtime.resolveContext(sess);
    const globalConnectsBefore = mockMcp.connectCalls.filter((c) =>
      c.serverIds.includes("global-mcp"),
    );

    // Kill the global pool.
    globalConnectsBefore[globalConnectsBefore.length - 1]!.pool.dead = true;

    await runtime.resolveContext(sess);
    const globalConnectsAfter = mockMcp.connectCalls.filter((c) =>
      c.serverIds.includes("global-mcp"),
    );
    expect(globalConnectsAfter.length).toBe(globalConnectsBefore.length + 1);

    await runtime.shutdown();
  });
});
