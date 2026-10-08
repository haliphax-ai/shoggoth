/**
 * Persistent subagent spawns arm an inactivity timeout, not a wall-clock lifetime:
 * the session is auto-terminated after `lifetime_ms` (or the default inactivity window
 * when omitted) without a delivered response, for both thread-bound and threadless
 * spawns. A touch (one fired per delivered response in the daemon) resets the clock.
 */

import { describe, it, beforeAll, afterAll, afterEach, vi } from "vitest";

let sharedDir = "";
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => join(sharedDir, "templates"),
}));
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
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import {
  clearAllPersistentSubagentInactivityTimers,
  touchPersistentSubagentInactivityTimer,
} from "../../src/subagent/persistent-subagent-timers";
import { SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS } from "../../src/subagent/subagent-constants";
import { startControlPlane } from "../../src/control/control-plane";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";

let prevOperatorToken: string | undefined;
beforeAll(async () => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
  sharedDir = await mkdtemp(join(tmpdir(), "shoggoth-si-shared-"));
});
afterAll(() => {
  if (prevOperatorToken === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  else process.env.SHOGGOTH_OPERATOR_TOKEN = prevOperatorToken;
});

const TEST_OPERATOR_TOKEN = "test-op-token";

function minimalConfig(dir: string): ShoggothConfig {
  const socketPath = join(dir, "c.sock");
  return {
    logLevel: "info",
    stateDbPath: join(dir, "state.db"),
    socketPath,
    workspacesRoot: join(dir, "workspaces"),
    secretsDirectory: join(dir, "secrets"),
    inboundMediaRoot: join(dir, "media"),
    configDirectory: join(dir, "config"),
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
  options: {
    stateDb?: Database.Database;
    config?: ShoggothConfig;
  },
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-si-"));
  const config = options.config ?? minimalConfig(dir);
  const socketPath = config.socketPath;

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
      const c = createConnection(socketPath);
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

type SpawnPersistentResult = {
  session_id: string;
  expires_at_ms: number;
};

async function spawnPersistent(
  db: Database.Database,
  config: ShoggothConfig,
  parentId: string,
  payload: Record<string, unknown>,
): Promise<SpawnPersistentResult> {
  let captured!: SpawnPersistentResult;

  setSubagentRuntimeExtension({
    runSessionModelTurn: async () => ({
      latestAssistantText: "REPLY",
      failoverMeta: undefined,
    }),
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
  });

  try {
    await withControlPlaneSession({ stateDb: db, config }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "si-1",
        op: "subagent_spawn",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          parent_session_id: parentId,
          prompt: "monitor ci",
          mode: "persistent",
          ...payload,
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `spawn failed: ${JSON.stringify(res.error)}`);
      captured = res.result as SpawnPersistentResult;
    });
  } finally {
    setSubagentRuntimeExtension(undefined);
  }

  return captured;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupDb(): Promise<{
  db: Database.Database;
  config: ShoggothConfig;
  parentId: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-si-"));
  const db = new Database(join(dir, "state.db"));
  migrate(db, defaultMigrationsDir());
  const parentId = formatAgentSessionUrn(
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
  return { db, config: minimalConfig(dir), parentId };
}

function sessionStatus(db: Database.Database, sessionId: string): string | undefined {
  return createSessionStore(db).getById(sessionId)?.status;
}

describe("subagent_spawn persistent inactivity timeout", () => {
  afterEach(() => {
    clearAllPersistentSubagentInactivityTimers();
    setSubagentRuntimeExtension(undefined);
  });

  it("thread-bound spawn arms lifetime_ms as the inactivity window and expires without touch", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();

    const before = Date.now();
    const r = await spawnPersistent(db, config, parentId, {
      platform_thread_id: "555",
      lifetime_ms: 400,
    });

    assert.ok(r.expires_at_ms >= before + 400);
    assert.ok(r.expires_at_ms <= Date.now() + 400);

    const store = createSessionStore(db);
    const row = store.getById(r.session_id);
    assert.ok(row);
    assert.equal(row.subagentMode, "persistent");
    assert.equal(row.subagentPlatformThreadId, "555");
    assert.equal(row.subagentExpiresAtMs, r.expires_at_ms);

    // No delivered response within the window → inactivity expiry terminates it.
    await sleep(1_000);
    assert.equal(sessionStatus(db, r.session_id), "terminated");
    db.close();
  });

  it("threadless spawn without lifetime_ms defaults to the inactivity timeout", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();

    const before = Date.now();
    const r = await spawnPersistent(db, config, parentId, {});

    assert.ok(r.expires_at_ms >= before + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS);
    assert.ok(r.expires_at_ms <= Date.now() + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS);

    const row = createSessionStore(db).getById(r.session_id);
    assert.ok(row);
    assert.equal(row.subagentPlatformThreadId, undefined);
    assert.equal(row.subagentExpiresAtMs, r.expires_at_ms);
    assert.equal(sessionStatus(db, r.session_id), "active");
    db.close();
  });

  it("a touch (delivered response) resets the inactivity clock", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();

    const r = await spawnPersistent(db, config, parentId, { lifetime_ms: 1_500 });
    const store = createSessionStore(db);

    await sleep(600);
    touchPersistentSubagentInactivityTimer(r.session_id);
    const touched = store.getById(r.session_id);
    assert.ok(touched?.subagentExpiresAtMs !== undefined);
    assert.ok(touched.subagentExpiresAtMs > r.expires_at_ms);

    // Past the original expiry, within the re-armed window: still alive.
    await sleep(700);
    assert.equal(sessionStatus(db, r.session_id), "active");

    // Past the re-armed expiry: terminated.
    await sleep(1_200);
    assert.equal(sessionStatus(db, r.session_id), "terminated");
    db.close();
  });
});
