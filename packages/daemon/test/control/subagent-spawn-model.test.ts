/**
 * Tests for subagentModel config resolution during subagent_spawn.
 *
 * Resolution order:
 * 1. Per-spawn model_options.model (highest priority)
 * 2. Per-agent agents.list.<parentId>.subagentModel
 * 3. Global agents.subagentModel
 * 4. Inherit from parent (default)
 */

import { describe, it, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
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
import { startControlPlane } from "../../src/control/control-plane";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";

let prevOperatorToken: string | undefined;
beforeAll(() => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
});
afterAll(() => {
  if (prevOperatorToken === undefined)
    delete process.env.SHOGGOTH_OPERATOR_TOKEN;
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

type CapturedSpawn = {
  sessionId: string;
  userContent: string;
  userMetadata?: Record<string, unknown>;
  delivery: { kind: string };
};

async function withControlPlaneSession(
  options: {
    stateDb?: Database.Database;
    config?: ShoggothConfig;
  },
  fn: (
    send: (body: Record<string, unknown>) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-"));
  const sock = join(dir, "c.sock");
  const config = options.config ?? minimalConfig(sock);
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

/** Spawn a subagent via the control plane and return the session's modelSelection from the DB. */
async function spawnAndGetModelSelection(
  config: ShoggothConfig,
  db: Database.Database,
  parentId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  let spawnedSessionId: string | undefined;

  setSubagentRuntimeExtension({
    runSessionModelTurn: async (input: CapturedSpawn) => {
      spawnedSessionId = input.sessionId;
      return { latestAssistantText: "REPLY", failoverMeta: undefined };
    },
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
  });

  try {
    await withControlPlaneSession({ stateDb: db, config }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-1",
        op: "subagent_spawn",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          parent_session_id: parentId,
          prompt: "test task",
          mode: "one_shot",
          ...payload,
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `spawn failed: ${JSON.stringify(res.error)}`);
    });
  } finally {
    setSubagentRuntimeExtension(undefined);
  }

  assert.ok(spawnedSessionId, "subagent session must have been spawned");
  const row = db
    .prepare("SELECT model_selection_json FROM sessions WHERE id = ?")
    .get(spawnedSessionId) as
    | { model_selection_json: string | null }
    | undefined;
  return row?.model_selection_json
    ? JSON.parse(row.model_selection_json)
    : undefined;
}

describe("subagentModel config resolution", () => {
  it("inherits parent modelSelection when no subagentModel configured", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-inherit-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "parent/original-model" },
    });

    const sel = await spawnAndGetModelSelection(
      minimalConfig(sock),
      db,
      parentId,
      {},
    );

    assert.ok(sel && typeof sel === "object");
    assert.equal(
      (sel as Record<string, unknown>).model,
      "parent/original-model",
    );
    db.close();
  });

  it("applies global agents.subagentModel when set", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-global-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "parent/original" },
    });

    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      agents: {
        subagentModel: "provider-a/small-model",
      },
    };

    const sel = await spawnAndGetModelSelection(config, db, parentId, {});

    assert.ok(sel && typeof sel === "object");
    assert.equal(
      (sel as Record<string, unknown>).model,
      "provider-a/small-model",
    );
    db.close();
  });

  it("per-agent subagentModel overrides global", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-peragent-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "parent/original" },
    });

    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      agents: {
        subagentModel: "provider-a/global-model",
        list: {
          par: {
            subagentModel: "provider-b/agent-specific-model",
          },
        },
      },
    };

    const sel = await spawnAndGetModelSelection(config, db, parentId, {});

    assert.ok(sel && typeof sel === "object");
    assert.equal(
      (sel as Record<string, unknown>).model,
      "provider-b/agent-specific-model",
    );
    db.close();
  });

  it("per-spawn model_options.model takes precedence over config", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-spawn-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "parent/original" },
    });

    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      agents: {
        subagentModel: "provider-a/global-model",
        list: {
          par: {
            subagentModel: "provider-b/agent-model",
          },
        },
      },
    };

    const sel = await spawnAndGetModelSelection(config, db, parentId, {
      model_options: { model: "provider-c/spawn-override" },
    });

    assert.ok(sel && typeof sel === "object");
    assert.equal(
      (sel as Record<string, unknown>).model,
      "provider-c/spawn-override",
    );
    db.close();
  });

  it("global subagentModel applies when parent agent has no per-agent override", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-noagent-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
    });

    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      agents: {
        subagentModel: "provider-x/fallback-model",
        list: {
          other_agent: {
            subagentModel: "provider-y/not-this-one",
          },
        },
      },
    };

    const sel = await spawnAndGetModelSelection(config, db, parentId, {});

    assert.ok(sel && typeof sel === "object");
    assert.equal(
      (sel as Record<string, unknown>).model,
      "provider-x/fallback-model",
    );
    db.close();
  });

  it("no modelSelection on parent and no subagentModel config yields undefined", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-none-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
    });

    const sel = await spawnAndGetModelSelection(
      minimalConfig(sock),
      db,
      parentId,
      {},
    );

    assert.equal(sel, undefined);
    db.close();
  });

  it("subagentModel merges into existing parent modelSelection object", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-merge-"));
    const sock = join(dir, "c.sock");
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
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "parent/old", temperature: 0.5 },
    });

    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      agents: {
        subagentModel: "provider-z/new-model",
      },
    };

    const sel = await spawnAndGetModelSelection(config, db, parentId, {});

    assert.ok(sel && typeof sel === "object");
    const obj = sel as Record<string, unknown>;
    assert.equal(obj.model, "provider-z/new-model");
    // temperature from parent should be preserved
    assert.equal(obj.temperature, 0.5);
    db.close();
  });
});
