/**
 * RED-phase TDD tests for per-session MCP pool agent identity (Phase 4).
 *
 * These tests verify:
 * 1. When `resolveContext` connects per-session servers, the
 *    `connectShoggothMcpServers` call receives `agentContext` with the correct
 *    uid, gid, and workspacePath derived from the session's agent ID.
 * 2. When the session URN cannot be parsed (no agent ID), the per-session pool
 *    falls back to daemon identity (no agentContext).
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

/** Minimal per-session MCP server entry (stdio, poolScope per_session). */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-session MCP pool agent identity (Phase 4)", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-per-session-id-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    closeTestDb(db, tmp);
  });

  // -----------------------------------------------------------------------
  // 1. Per-session pool receives agentContext when session has a valid agent URN
  // -----------------------------------------------------------------------
  it("connectShoggothMcpServers receives agentContext with uid/gid/workspacePath for per-session pool", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perSessionServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const agentId = "session-identity-agent";
    const sessionUrn = formatAgentSessionUrn(
      agentId,
      "discord",
      "channel",
      "aaaaaaaa-0000-4000-8000-000000000001",
    );

    await runtime.resolveContext(sessionUrn);

    // Find the connect call for the per-session server
    const perSessionConnect = mockMcp.connectCalls.find((c) => c.serverIds.includes("session-mcp"));
    expect(perSessionConnect).toBeDefined();

    // The per-session connect call MUST include agentContext
    expect(perSessionConnect!.options).toBeDefined();
    expect(perSessionConnect!.options!.agentContext).toBeDefined();

    const ctx = perSessionConnect!.options!.agentContext!;
    expect(ctx.workspacePath).toContain(agentId);
    expect(typeof ctx.uid).toBe("number");
    expect(typeof ctx.gid).toBe("number");

    await runtime.shutdown();
  });

  // -----------------------------------------------------------------------
  // 2. Per-session pool without parseable agent ID falls back (no agentContext)
  // -----------------------------------------------------------------------
  it("per-session pool falls back to daemon identity when session URN has no agent ID", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithServers(tmp, [perSessionServer()]);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Use a session ID that is NOT a valid agent URN
    const badSessionId = "not-a-valid-agent-urn";

    await runtime.resolveContext(badSessionId);

    // Find the connect call for the per-session server
    const perSessionConnect = mockMcp.connectCalls.find((c) => c.serverIds.includes("session-mcp"));
    expect(perSessionConnect).toBeDefined();

    // When the agent ID cannot be parsed, agentContext should be absent
    // (the pool runs as the daemon, not as a specific agent).
    const agentCtx = perSessionConnect!.options?.agentContext;
    expect(agentCtx).toBeUndefined();

    await runtime.shutdown();
  });
});
