/**
 * RED-phase TDD tests for per-session MCP pool idle timeout wiring (Phase 1).
 *
 * These tests verify:
 * 1. `notifyTurnBegin` / `notifyTurnEnd` are called during inbound turns (wiring gap).
 * 2. After `notifyTurnEnd`, the idle timer fires and evicts the per-session pool.
 * 3. `notifyTurnBegin` cancels a pending idle timer.
 * 4. After eviction, `resolveContext` triggers a fresh connect (reconnect-after-eviction).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionMcpRuntime } from "../../src/sessions/session-mcp-runtime";
import { runInboundSessionTurn } from "../../src/messaging/inbound-session-turn";
import type { McpServerPool } from "../../src/mcp/mcp-server-pool";
import type { ShoggothConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import { defaultConfig, SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS } from "@shoggoth/shared";
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

/** Build a config with one per-session MCP server and a short idle timeout. */
function configWithPerSessionMcp(workspacePath: string, idleMs = 5000): ShoggothConfig {
  const cfg = defaultConfig(workspacePath);
  cfg.mcp = {
    ...cfg.mcp,
    servers: [perSessionServer()],
    poolScope: "per_session",
    perSessionIdleTimeoutMs: idleMs,
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
// 1. notifyTurnBegin / notifyTurnEnd called during inbound turns
// ---------------------------------------------------------------------------

describe("per-session MCP idle timeout — turn lifecycle wiring", () => {
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

  /**
   * This is the KEY wiring-gap test: when a platform orchestrator runs a turn
   * for a session with per-session MCP servers, the runtime's notifyTurnBegin
   * and notifyTurnEnd must be wired into the mcpLifecycle hooks.
   *
   * Currently, no caller constructs mcpLifecycle from the runtime — this test
   * should FAIL until the wiring is added.
   */
  it("orchestrateInboundTurn wires runtime.notifyTurnBegin/notifyTurnEnd into mcpLifecycle", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithPerSessionMcp(tmp, 60_000);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Spy on the runtime's notify methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const beginSpy = vi.spyOn(runtime, "notifyTurnBegin" as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endSpy = vi.spyOn(runtime, "notifyTurnEnd" as any);

    // Import and use the PresentationTurnOrchestrator
    const { PresentationTurnOrchestrator } =
      await import("../../src/presentation/turn-orchestrator");

    const orchestrator = new PresentationTurnOrchestrator({
      config,
      env: process.env,
      adapter: {
        maxBodyLength: 4000,
        sendBody: vi.fn(async () => {}),
        sendError: vi.fn(async () => {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    // Run a turn — the orchestrator should wire mcpLifecycle from the runtime.
    // This will FAIL because the orchestrator does not auto-wire the runtime hooks.
    await orchestrator.orchestrateInboundTurn({
      sessionId: "sess-wiring",
      buildTurn: async () => ({
        db,
        sessionId: "sess-wiring",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: { id: "sess-wiring", workspacePath: tmp } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transcript: { append: vi.fn(), getAll: vi.fn(() => []) } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolRuns: { append: vi.fn() } as any,
        userContent: "hello",
        userMetadata: undefined,
        systemPrompt: "test",
        env: process.env,
        config,
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
    });

    // The runtime's notifyTurnBegin/notifyTurnEnd should have been called.
    // This FAILS because no caller wires mcpLifecycle from the runtime.
    expect(beginSpy).toHaveBeenCalledWith("sess-wiring");
    expect(endSpy).toHaveBeenCalledWith("sess-wiring");

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 2–4. Idle timer scheduling, eviction, and reconnect-after-eviction
// ---------------------------------------------------------------------------

describe("per-session MCP idle timeout — timer and eviction", () => {
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

    expect(runtime.trackPerSessionIdle).toBe(true);

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

  it("notifyTurnBegin cancels a pending idle timer", async () => {
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

  it("after eviction, resolveContext triggers a fresh connect (reconnect-after-eviction)", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 3000;
    const config = configWithPerSessionMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    // Initial connect
    await runtime.resolveContext("sess-reconnect");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(1);

    // End turn → schedule idle timer
    runtime.notifyTurnEnd("sess-reconnect");

    // Evict
    vi.advanceTimersByTime(idleMs + 100);
    expect(mockMcp.closeFns[0]).toHaveBeenCalledOnce();

    // Reconnect — resolveContext should trigger a brand new connect
    await runtime.resolveContext("sess-reconnect");
    expect(mockMcp.connectShoggothMcpServers).toHaveBeenCalledTimes(2);

    // The second pool should be a different close fn
    expect(mockMcp.closeFns).toHaveLength(2);
    expect(mockMcp.closeFns[1]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("idle timer does not fire when perSessionIdleTimeoutMs is 0 (disabled)", async () => {
    const mockMcp = createMockConnectMcp();
    const config = configWithPerSessionMcp(tmp, 0);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    expect(runtime.trackPerSessionIdle).toBe(false);

    await runtime.resolveContext("sess-disabled");
    runtime.notifyTurnEnd("sess-disabled");

    // Advance a long time — nothing should happen
    vi.advanceTimersByTime(SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS * 2);
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("multiple turns reset the idle timer (only the last notifyTurnEnd matters)", async () => {
    const mockMcp = createMockConnectMcp();
    const idleMs = 5000;
    const config = configWithPerSessionMcp(tmp, idleMs);

    const runtime = await createSessionMcpRuntime({
      config,
      env: process.env,
      db,
      deps: { connectShoggothMcpServers: mockMcp.connectShoggothMcpServers },
    });

    await runtime.resolveContext("sess-multi");

    // First turn cycle
    runtime.notifyTurnEnd("sess-multi");
    vi.advanceTimersByTime(3000); // 3s into 5s timeout

    // Second turn begins — cancels timer
    runtime.notifyTurnBegin("sess-multi");
    // Second turn ends — restarts timer
    runtime.notifyTurnEnd("sess-multi");

    // Advance 3s — would have been past original timeout but not the reset one
    vi.advanceTimersByTime(3000);
    expect(mockMcp.closeFns[0]).not.toHaveBeenCalled();

    // Advance past the reset timeout
    vi.advanceTimersByTime(3000);
    expect(mockMcp.closeFns[0]).toHaveBeenCalledOnce();

    await runtime.shutdown();
  });
});
