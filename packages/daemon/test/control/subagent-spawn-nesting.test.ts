/**
 * Tests for the maxSpawnDepth nesting gate on the subagent_spawn control op.
 *
 * The depth gate is an *additional* check that runs after the spawn-permission
 * gates (spawnSubagents / subagentSpawnAllow — covered elsewhere). Default
 * config (maxSpawnDepth unset = 1) preserves the historical behavior: a
 * top-level session may spawn, a subagent may not.
 */
import { describe, it, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { WIRE_VERSION, parseResponseLine } from "@shoggoth/authn";
import {
  DEFAULT_POLICY_CONFIG,
  formatAgentSessionUrn,
  mintSubagentSessionUrnFromParent,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import { startControlPlane } from "../../src/control/control-plane";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";

// ensureAgentWorkspaceLayout spawns node with the agent uid/gid (900) — EPERM on the
// non-root CI runner. Mock it like the other spawn tests (control-plane.test.ts et al.).
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
}));

let prevOperatorToken: string | undefined;
beforeAll(() => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
});
afterAll(() => {
  if (prevOperatorToken === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  else process.env.SHOGGOTH_OPERATOR_TOKEN = prevOperatorToken;
});

function minimalConfig(socketPath: string): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: join(socketPath, "..", "state.db"),
    socketPath,
    workspacesRoot: join(socketPath, "..", "workspaces"),
    secretsDirectory: "/tmp",
    inboundMediaRoot: "/tmp",
    configDirectory: "/tmp",
    hitl: {
      defaultApprovalTimeoutMs: 300_000,
      toolRisk: { read: "safe", write: "caution", exec: "critical" },
      bypassUpTo: "safe",
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
  };
}

async function withControlPlaneSession(
  options: { stateDb?: Database.Database; config?: ShoggothConfig },
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-nest-"));
  const config = options.config ?? minimalConfig(join(dir, "c.sock"));
  const logger = createLogger({ component: "test", minLevel: "error" });
  const health = new HealthRegistry();
  const shutdown = new ShutdownCoordinator({
    logger: logger.child({ subsystem: "shutdown" }),
    drainTimeoutMs: 5000,
  });
  const { close } = await startControlPlane({
    config,
    logger,
    shutdown,
    getHealth: () => health.snapshot(),
    version: "test-0",
    registerShutdownDrain: false,
    stateDb: options.stateDb,
  });
  const send = (body: Record<string, unknown>) =>
    new Promise<string>((resolve, reject) => {
      const c = createConnection(config.socketPath);
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i >= 0) {
          resolve(buf.slice(0, i));
          c.end();
        }
      });
      c.on("error", reject);
      c.on("connect", () => {
        c.write(`${JSON.stringify(body)}\n`);
      });
    });
  try {
    await fn(send);
  } finally {
    await close();
  }
}

function stubRuntime(capture?: { sessionId?: string }): void {
  setSubagentRuntimeExtension({
    runSessionModelTurn: async (input) => {
      if (capture) capture.sessionId = input.sessionId;
      return { latestAssistantText: "REPLY", failoverMeta: undefined };
    },
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
  });
}

interface WireResult {
  ok: boolean;
  error?: { code?: string };
  result?: Record<string, unknown>;
}

describe("subagent_spawn maxSpawnDepth nesting gate", () => {
  let db: Database.Database;
  let dir: string;
  let topId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shoggoth-nest-db-"));
    db = new Database(join(dir, "state.db"));
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    topId = formatAgentSessionUrn(
      "par",
      "discord",
      "channel",
      SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
    );
    sessions.create({
      id: topId,
      workspacePath: join(dir, "workspace"),
      status: "active",
    });
  });

  afterEach(() => {
    setSubagentRuntimeExtension(undefined);
    db.close();
  });

  function createSubagentRow(parentId: string): string {
    const sessions = createSessionStore(db);
    const id = mintSubagentSessionUrnFromParent(parentId);
    sessions.create({
      id,
      workspacePath: join(dir, "workspace"),
      status: "active",
    });
    sessions.update(id, { parentSessionId: parentId });
    return id;
  }

  async function spawnAsAgent(
    authSessionId: string,
    token: string,
    parentSessionId: string,
    configExtra: Partial<ShoggothConfig> = {},
  ): Promise<WireResult> {
    let parsed: WireResult | undefined;
    await withControlPlaneSession(
      {
        stateDb: db,
        config: { ...minimalConfig(join(dir, "c.sock")), ...configExtra },
      },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "nest-1",
          op: "subagent_spawn",
          auth: { kind: "agent", session_id: authSessionId, token },
          payload: {
            parent_session_id: parentSessionId,
            prompt: "task",
            mode: "one_shot",
          },
        });
        parsed = parseResponseLine(line) as WireResult;
      },
    );
    assert.ok(parsed, "response expected");
    return parsed!;
  }

  it("default config: top-level session (depth 0) may spawn", async () => {
    createSqliteAgentTokenStore(db).register(topId, "tok-top");
    const capture: { sessionId?: string } = {};
    stubRuntime(capture);
    const res = await spawnAsAgent(topId, "tok-top", topId);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(capture.sessionId, "subagent session must have been spawned");
  });

  it("default config: subagent (depth 1) may not spawn", async () => {
    const childId = createSubagentRow(topId);
    createSqliteAgentTokenStore(db).register(childId, "tok-child");
    stubRuntime();
    const res = await spawnAsAgent(childId, "tok-child", childId);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_SUBAGENT_NESTING_FORBIDDEN");
  });

  it("maxSpawnDepth 2: subagent (depth 1) may spawn", async () => {
    const childId = createSubagentRow(topId);
    createSqliteAgentTokenStore(db).register(childId, "tok-child");
    const capture: { sessionId?: string } = {};
    stubRuntime(capture);
    const res = await spawnAsAgent(childId, "tok-child", childId, { maxSpawnDepth: 2 });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(capture.sessionId, "nested subagent session must have been spawned");
  });

  it("maxSpawnDepth 2: depth-2 subagent may not spawn", async () => {
    const childId = createSubagentRow(topId);
    const grandchildId = createSubagentRow(childId);
    createSqliteAgentTokenStore(db).register(grandchildId, "tok-grandchild");
    stubRuntime();
    const res = await spawnAsAgent(grandchildId, "tok-grandchild", grandchildId, {
      maxSpawnDepth: 2,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_SUBAGENT_NESTING_FORBIDDEN");
  });

  it("per-agent maxSpawnDepth overrides top-level default", async () => {
    const childId = createSubagentRow(topId);
    createSqliteAgentTokenStore(db).register(childId, "tok-child");
    const capture: { sessionId?: string } = {};
    stubRuntime(capture);
    const res = await spawnAsAgent(childId, "tok-child", childId, {
      agents: { list: { par: { maxSpawnDepth: 2 } } },
    });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(capture.sessionId, "nested subagent session must have been spawned");
  });

  it("maxSpawnDepth 0: top-level session may not spawn", async () => {
    createSqliteAgentTokenStore(db).register(topId, "tok-top");
    stubRuntime();
    const res = await spawnAsAgent(topId, "tok-top", topId, { maxSpawnDepth: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_SUBAGENT_NESTING_FORBIDDEN");
  });
});
