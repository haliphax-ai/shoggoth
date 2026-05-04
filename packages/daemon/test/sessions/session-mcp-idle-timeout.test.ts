/**
 * RED-phase TDD tests for unified MCP pool idle eviction (Phase 5).
 *
 * These tests verify:
 * 1. `trackInstanceIdle` — true when perInstanceIdleTimeoutMs > 0 and at least one MCP server.
 * 2. `notifyTurnBegin` / `notifyTurnEnd` are called during inbound turns (wiring gap).
 * 3. Per-session idle eviction using `perInstanceIdleTimeoutMs`.
 * 4. Global pool idle eviction — after notifyTurnEnd with no subsequent turn, global pool evicted.
 * 5. Turn begin cancels eviction timers for all applicable scopes.
 * 6. shutdown() clears global, per-agent, and per-session idle timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionMcpRuntime } from "../../src/sessions/session-mcp-runtime";
import { runInboundSessionTurn } from "../../src/messaging/inbound-session-turn";
import type { McpServerPool } from "../../src/mcp/mcp-server-pool";
import type { ShoggothConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import { defaultConfig, SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS } from "@shoggoth/shared";
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
function perSessionServer(id = "test-mcp"): ShoggothMcpServerEntry {
  return {
    id,
    transport: "stdio" as const,
    command: "echo",
    poolScope: "per_session",
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

/** Build a config with one per-session MCP server and a short idle timeout. */
function configWithPerSessionMcp(workspacePath: string, idleMs = 5000): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = {
    ...cfg.mcp,
    servers: [perSessionServer()],
    poolScope: "per_session",
    perInstanceIdleTimeoutMs: idleMs,
  };
  return cfg;
}

/** Build a config with one global MCP server and a short idle timeout. */
function configWithGlobalMcp(workspacePath: string, idleMs = 5000): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = {
    ...cfg.mcp,
    servers: [globalServer()],
    poolScope: "global",
    perInstanceIdleTimeoutMs: idleMs,
  };
  return cfg;
}

/**
 * Creates a mock `connectShoggothMcpServers` that tracks connect/close calls.
 * Each call returns a pool with a `close` spy and empty external sources.
 */
function createMockConnectMcp() {
  const connectCalls: string[][] = [];
  const closeFns: ReturnType<typeof vi.fn>[] = [];

  const connectShoggothMcpServers = vi.fn(async (servers: readonly ShoggothMcpServerEntry[]) => {
    connectCalls.push(servers.map((s) => s.id));
    const closeFn = vi.fn(async () => {});
    closeFns.push(closeFn);
    const pool: McpServerPool = {
      externalSources: [],
      close: closeFn,
    };
    return {
      pool,
      external: vi.fn(async () => ({ resultJson: "{}" })),
    };
  });

  return { connectShoggothMcpServers, connectCalls, closeFns };
}

// ---------------------------------------------------------------------------
// 1. trackInstanceIdle — unified idle tracking flag
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — trackInstanceIdle", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    closeTestDb(db, tmp);
  });

  it("trackInstanceIdle is true when perInstanceIdleTimeoutMs > 0 and at least one MCP server is configured", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithPerSessionMcp(tmp, 5000);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // The unified property should exist and be true.
    expect((runtime as any).trackInstanceIdle).toBe(true);

    await runtime.shutdown();
  });

  it("trackInstanceIdle is true for global-only MCP servers with perInstanceIdleTimeoutMs > 0", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithGlobalMcp(tmp, 5000);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // trackInstanceIdle should be true even for global-only servers.
    expect((runtime as any).trackInstanceIdle).toBe(true);

    await runtime.shutdown();
  });

  it("trackInstanceIdle is false when perInstanceIdleTimeoutMs is 0", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithPerSessionMcp(tmp, 0);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    expect((runtime as any).trackInstanceIdle).toBe(false);

    await runtime.shutdown();
  });

  it("trackInstanceIdle is false when no MCP servers are configured", async () => {
    const mockMcp = createMockConnectMcp();
    const cfg = defaultConfig(tmp);
    cfg.mcp = { ...cfg.mcp, servers: [], perInstanceIdleTimeoutMs: 5000 };

    const runtime = await createSessionMcpRuntime({
      config: cfg,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    expect((runtime as any).trackInstanceIdle).toBe(false);

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 2. notifyTurnBegin / notifyTurnEnd called during inbound turns
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — turn lifecycle wiring", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("runInboundSessionTurn calls mcpLifecycle.onTurnBegin at start and onTurnEnd at end (success path)", async () => {
    const onTurnBegin = vi.fn();
    const onTurnEnd = vi.fn();

    await runInboundSessionTurn({
      buildTurn: async () => ({
        db,
        sessionId: "sess-1",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: { id: "sess-1", workspacePath: tmp } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transcript: { append: vi.fn(), getAll: vi.fn(() => []) } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolRuns: { append: vi.fn() } as any,
        userContent: "hello",
        userMetadata: undefined,
        systemPrompt: "test",
        env: process.env,
        config: defaultConfig(tmp),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policyEngine: { evaluate: vi.fn() } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getHitlConfig: () => ({}) as any,
        hitl: {
          bypassUpTo: "safe",
          pending: {
            add: vi.fn(),
            remove: vi.fn(),
            getAll: vi.fn(() => []),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          clock: { nowMs: () => Date.now() },
          newPendingId: () => "id",
          waitForHitlResolution: vi.fn(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        loopImpl: vi.fn(async () => ({
          latestAssistantText: "reply",
          failoverMeta: undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any,
        createToolCallingClient: () =>
          ({
            completeWithTools: vi.fn(async () => ({
              content: "reply",
              toolCalls: [],
              usedModel: "stub",
              usedProviderId: "stub",
              degraded: false,
            })),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
        resolveMcpContext: async () => ({
          aggregated: { tools: [] },
          toolsOpenAi: [],
          toolsLoop: { tools: [], externalInvoke: undefined },
        }),
      }),
      sliceDisplayText: (t) => t,
      formatAssistantReply: (t) => t,
      formatErrorReply: (e) => String(e),
      sendAssistantBody: vi.fn(async () => {}),
      sendErrorBody: vi.fn(async () => {}),
      mcpLifecycle: { onTurnBegin, onTurnEnd },
    });

    expect(onTurnBegin).toHaveBeenCalledOnce();
    expect(onTurnEnd).toHaveBeenCalledOnce();
  });

  it("runInboundSessionTurn calls onTurnEnd even when the turn throws (error path)", async () => {
    const onTurnBegin = vi.fn();
    const onTurnEnd = vi.fn();

    await runInboundSessionTurn({
      buildTurn: async () => {
        throw new Error("build failed");
      },
      sliceDisplayText: (t) => t,
      formatAssistantReply: (t) => t,
      formatErrorReply: (e) => String(e),
      sendAssistantBody: vi.fn(async () => {}),
      sendErrorBody: vi.fn(async () => {}),
      mcpLifecycle: { onTurnBegin, onTurnEnd },
    });

    expect(onTurnBegin).toHaveBeenCalledOnce();
    expect(onTurnEnd).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 3. Per-session idle eviction (using perInstanceIdleTimeoutMs)
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — per-session pool", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeTestDb(db, tmp);
  });

  it("notifyTurnEnd schedules an idle timer that evicts the per-session pool", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerSessionMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Trigger lazy connect by resolving context
    const _ctx1 = await runtime.resolveContext("sess-idle");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(1);

    // Simulate turn end — should schedule idle timer
    runtime.notifyTurnEnd("sess-idle");

    // Advance time past the idle timeout
    vi.advanceTimersByTime(idleMs + 100);

    // The pool should have been evicted (close called)
    expect(mockMcp.closeFns[0]).toHaveBeenCalled();

    // Resolving context again should trigger a fresh connect
    const _ctx2 = await runtime.resolveContext("sess-idle");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(2);

    await runtime.shutdown();
  });

  it("notifyTurnBegin cancels a pending per-session idle timer", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerSessionMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Trigger lazy connect
    await runtime.resolveContext("sess-cancel");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(1);

    // End turn → schedules idle timer
    runtime.notifyTurnEnd("sess-cancel");

    // Advance partway (not past idle timeout)
    vi.advanceTimersByTime(idleMs - 1000);

    // Begin a new turn → should cancel the pending timer
    runtime.notifyTurnBegin("sess-cancel");

    // Advance well past the original timeout
    vi.advanceTimersByTime(idleMs * 2);

    // Pool should NOT have been evicted — close should not have been called
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    // Context should still be cached (no reconnect)
    await runtime.resolveContext("sess-cancel");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(1);

    await runtime.shutdown();
  });

  it("idle timer does not fire when perInstanceIdleTimeoutMs is 0 (disabled)", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithPerSessionMcp(tmp, 0);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-disabled");
    runtime.notifyTurnEnd("sess-disabled");

    // Advance a long time — nothing should happen
    vi.advanceTimersByTime(SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS * 2);
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 4. Global pool idle eviction
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — global pool", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeTestDb(db, tmp);
  });

  it("notifyTurnEnd with no subsequent notifyTurnBegin evicts the global pool after timeout", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithGlobalMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Resolve context to trigger the global pool connect
    await runtime.resolveContext("sess-global-1");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(1);

    // End turn — should schedule global idle timer
    runtime.notifyTurnEnd("sess-global-1");

    // Advance past the idle timeout
    vi.advanceTimersByTime(idleMs + 100);

    // The global pool should have been evicted (close called).
    expect(mockMcp.closeFns[0]).toHaveBeenCalled();

    // Resolving context again should trigger a fresh global connect
    await runtime.resolveContext("sess-global-1");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(2);

    await runtime.shutdown();
  });

  it("notifyTurnBegin cancels a pending global idle timer", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithGlobalMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-global-cancel");

    // End turn → schedules global idle timer
    runtime.notifyTurnEnd("sess-global-cancel");

    // Advance partway
    vi.advanceTimersByTime(idleMs - 1000);

    // Begin a new turn → should cancel the global idle timer.
    runtime.notifyTurnBegin("sess-global-cancel");

    // Advance well past the original timeout
    vi.advanceTimersByTime(idleMs * 2);

    // Global pool should NOT have been evicted
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("multiple sessions sharing global pool: eviction only fires when ALL sessions are idle", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithGlobalMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-a");
    await runtime.resolveContext("sess-b");

    // End turn for sess-a
    runtime.notifyTurnEnd("sess-a");

    // Advance partway
    vi.advanceTimersByTime(idleMs - 1000);

    // sess-b starts a turn — should keep the global pool alive.
    runtime.notifyTurnBegin("sess-b");

    // Advance past original timeout
    vi.advanceTimersByTime(idleMs * 2);

    // Global pool should NOT have been evicted (sess-b is still active)
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    // Now end sess-b's turn
    runtime.notifyTurnEnd("sess-b");

    // Advance past timeout
    vi.advanceTimersByTime(idleMs + 100);

    // NOW the global pool should be evicted
    expect(mockMcp.closeFns[0]).toHaveBeenCalled();

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 5. Turn begin cancels eviction for all applicable scopes
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — turn begin cancels all scopes", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeTestDb(db, tmp);
  });

  it("notifyTurnBegin cancels pending eviction timers for global, per-agent, and per-session scopes", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      ...cfg.mcp,
      servers: [
        globalServer("g"),
        {
          id: "a",
          transport: "stdio" as const,
          command: "echo",
          poolScope: "per_agent",
        } as ShoggothMcpServerEntry,
        perSessionServer("s"),
      ],
      poolScope: "global",
      perInstanceIdleTimeoutMs: idleMs,
    };

    const runtime = await createSessionMcpRuntime({
      config: cfg,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    const sessionId = "agent:myagent:discord:channel:aaaaaaaa-0000-4000-8000-000000000001";

    // Resolve context to connect all pools
    await runtime.resolveContext(sessionId);

    // End turn — should schedule idle timers for all three scopes
    runtime.notifyTurnEnd(sessionId);

    // Advance partway
    vi.advanceTimersByTime(idleMs - 1000);

    // Begin a new turn — should cancel ALL pending idle timers.
    runtime.notifyTurnBegin(sessionId);

    // Advance well past the timeout
    vi.advanceTimersByTime(idleMs * 3);

    // None of the pools should have been evicted
    for (const closeFn of mockMcp.closeFns) {
      expect(closeFn).not.toHaveBeenCalled();
    }

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 6. shutdown() clears all idle timers
// ---------------------------------------------------------------------------

describe("unified MCP idle eviction — shutdown clears all timers", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-mcp-idle-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeTestDb(db, tmp);
  });

  it("shutdown clears global idle timer so eviction callback does not fire", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithGlobalMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-shutdown-global");

    // End turn — schedules global idle timer
    runtime.notifyTurnEnd("sess-shutdown-global");

    // Shutdown before the timer fires — should clear the timer.
    await runtime.shutdown();

    // Advance past the timeout — the eviction callback should NOT fire
    vi.advanceTimersByTime(idleMs * 2);

    // The pool was closed by shutdown, but the idle eviction callback should not
    // have fired (no double-close or errors from stale timer).
    // close is called once by shutdown, not again by the timer.
    expect(mockMcp.closeFns[0]).toHaveBeenCalledTimes(1);
  });

  it("shutdown clears per-session idle timers", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerSessionMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-shutdown-ps");
    runtime.notifyTurnEnd("sess-shutdown-ps");

    await runtime.shutdown();

    // Advance past the timeout — the eviction callback should NOT fire
    vi.advanceTimersByTime(idleMs * 2);

    // close called once by shutdown, not again by the timer
    expect(mockMcp.closeFns[0]).toHaveBeenCalledTimes(1);
  });
});
