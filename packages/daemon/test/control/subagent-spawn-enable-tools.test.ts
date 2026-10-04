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
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { getSessionToolState } from "../../src/sessions/session-tool-discovery";
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

const TEST_OPERATOR_TOKEN = "test-op-token";

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
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-se-"));
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

describe("subagent_spawn enable_tools", () => {
  let db: Database.Database;
  let parentId: string;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shoggoth-se-db-"));
    db = new Database(join(dir, "state.db"));
    migrate(db, defaultMigrationsDir());
    parentId = formatAgentSessionUrn(
      "par",
      "discord",
      "channel",
      SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
    );
    createSessionStore(db).create({
      id: parentId,
      workspacePath: join(dir, "workspace"),
      status: "active",
    });
  });

  afterEach(() => {
    setSubagentRuntimeExtension(undefined);
    db.close();
  });

  async function spawnOnce(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const capture: { sessionId?: string } = {};
    stubRuntime(capture);
    await withControlPlaneSession(
      { stateDb: db, config: minimalConfig(join(dir, "c.sock")) },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "se-1",
          op: "subagent_spawn",
          auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
          payload: {
            parent_session_id: parentId,
            prompt: "task",
            mode: "one_shot",
            ...payload,
          },
        });
        const res = parseResponseLine(line);
        assert.equal(
          res.ok,
          true,
          `spawn failed: ${JSON.stringify((res as { error?: unknown }).error)}`,
        );
      },
    );
    assert.ok(capture.sessionId, "subagent session must have been spawned");
    return getSessionToolState(db, capture.sessionId) as unknown as Record<string, unknown>;
  }

  it("records exact IDs and globs in the child session tool state", async () => {
    const state = (await spawnOnce({
      enable_tools: ["kanban-*", "builtin-exec"],
    })) as Map<string, boolean>;
    assert.equal(state.get("kanban-*"), true);
    assert.equal(state.get("builtin-exec"), true);
    assert.equal(state.size, 2);
  });

  it("writes no state when enable_tools is absent", async () => {
    const state = (await spawnOnce({})) as Map<string, boolean>;
    assert.equal(state.size, 0);
  });

  it("rejects a non-array enable_tools payload", async () => {
    stubRuntime();
    await withControlPlaneSession(
      { stateDb: db, config: minimalConfig(join(dir, "c.sock")) },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "se-bad",
          op: "subagent_spawn",
          auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
          payload: {
            parent_session_id: parentId,
            prompt: "task",
            mode: "one_shot",
            enable_tools: "kanban-*",
          },
        });
        const res = parseResponseLine(line) as { ok: boolean; error?: { code?: string } };
        assert.equal(res.ok, false);
        assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
      },
    );
  });
});
