/**
 * Phase 2 — Trusted System Context adoption tests.
 *
 * Verifies that each `runSessionModelTurn` call site passes the correct
 * `systemContext` with the expected `kind`, `summary`, and `data` fields.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WIRE_VERSION,
  parseResponseLine,
} from "@shoggoth/authn";
import type { SystemContext } from "@shoggoth/shared";
import {
  DEFAULT_POLICY_CONFIG,
  formatAgentSessionUrn,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { createSessionStore } from "../src/sessions/session-store.js";
import { createSqliteAgentTokenStore } from "../src/auth/sqlite-agent-tokens.js";
import { migrate, defaultMigrationsDir } from "../src/db/migrate.js";
import { setSubagentRuntimeExtension } from "../src/subagent/subagent-extension-ref.js";
import { startControlPlane, type ReadPeerCredFn } from "../src/control/control-plane.js";
import { createLogger } from "../src/logging.js";
import { HealthRegistry } from "../src/health.js";
import { ShutdownCoordinator } from "../src/shutdown.js";
import {
  createDaemonSpawnAdapter,
  createFanOutNotifier,
  type DaemonSpawnAdapterDeps,
} from "../src/fan-out-adapters.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(socketPath: string): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: join(socketPath, "..", "state.db"),
    socketPath,
    workspacesRoot: "/tmp",
    secretsDirectory: "/tmp",
    inboundMediaRoot: "/tmp",
    configDirectory: "/tmp",
    hitl: {
      defaultApprovalTimeoutMs: 300_000,
      toolRisk: { read: "safe", write: "caution", exec: "critical" },
      agentBypassUpTo: {},
      agentToolAutoApprove: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
  };
}

type CapturedInput = {
  sessionId: string;
  userContent: string;
  userMetadata?: Record<string, unknown>;
  systemContext?: SystemContext;
  delivery: { kind: string };
};

function capturingRunSessionModelTurn() {
  const calls: CapturedInput[] = [];
  const fn = async (input: CapturedInput) => {
    calls.push(input);
    return { latestAssistantText: "OK", failoverMeta: undefined };
  };
  return { fn, calls };
}

function capturingSubagentRuntimeExtension() {
  const captured = capturingRunSessionModelTurn();
  const ext = {
    runSessionModelTurn: captured.fn,
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
  };
  return { ext, calls: captured.calls };
}

async function withControlPlaneSession(
  options: {
    readPeerCred?: ReadPeerCredFn;
    stateDb?: Database.Database;
    config?: ShoggothConfig;
  },
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const { createConnection } = await import("node:net");
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-sc-"));
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
    readPeerCred: options?.readPeerCred,
    stateDb: options?.stateDb,
  });

  try {
    await fn(async (body) => {
      return new Promise<string>((resolve, reject) => {
        const c = createConnection(socketPath);
        let buf = "";
        c.on("data", (d: Buffer) => {
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
    });
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// 1. Subagent one_shot spawn — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: subagent_spawn one_shot", () => {
  it("passes systemContext with kind 'subagent.task' and correct data", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sc-os-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const parentId = formatAgentSessionUrn("ag", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    createSessionStore(db).create({ id: parentId, workspacePath: "/tmp/w", status: "active" });

    const { ext, calls } = capturingSubagentRuntimeExtension();
    setSubagentRuntimeExtension(ext);
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid!(), gid: process.getgid!(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sc-os-1",
            op: "subagent_spawn",
            auth: { kind: "operator_peercred" },
            payload: {
              parent_session_id: parentId,
              prompt: "do the thing",
              mode: "one_shot",
              respond_to: "caller-session",
            },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal(calls.length, 1);

          const sc = calls[0].systemContext;
          assert.ok(sc, "systemContext must be present");
          assert.equal(sc.kind, "subagent.task");
          assert.ok(sc.summary.length > 0, "summary must be non-empty");
          assert.ok(sc.summary.includes("one-shot"), "summary should mention one-shot");
          assert.ok(sc.data, "data must be present");
          assert.equal(sc.data!.parent_session_id, parentId);
          assert.equal(sc.data!.internal, true);
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Subagent persistent spawn — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: subagent_spawn persistent", () => {
  it("passes systemContext with kind 'subagent.task' and persistent data", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sc-ps-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const parentId = formatAgentSessionUrn("ag", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    createSessionStore(db).create({ id: parentId, workspacePath: "/tmp/w", status: "active" });

    const { ext, calls } = capturingSubagentRuntimeExtension();
    setSubagentRuntimeExtension(ext);
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid!(), gid: process.getgid!(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sc-ps-1",
            op: "subagent_spawn",
            auth: { kind: "operator_peercred" },
            payload: {
              parent_session_id: parentId,
              prompt: "persistent task",
              mode: "persistent",
              respond_to: "caller-session",
            },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal(calls.length, 1);

          const sc = calls[0].systemContext;
          assert.ok(sc, "systemContext must be present");
          assert.equal(sc.kind, "subagent.task");
          assert.ok(sc.summary.length > 0, "summary must be non-empty");
          assert.ok(sc.summary.includes("persistent"), "summary should mention persistent");
          assert.ok(sc.data, "data must be present");
          assert.equal(sc.data!.parent_session_id, parentId);
          assert.equal(sc.data!.internal, true);
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Session send — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: session_send", () => {
  it("passes systemContext with kind 'session.message' and sender info", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sc-ss-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const targetId = formatAgentSessionUrn("ag", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    createSessionStore(db).create({ id: targetId, workspacePath: "/w", status: "active" });

    const { ext, calls } = capturingSubagentRuntimeExtension();
    setSubagentRuntimeExtension(ext);
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid!(), gid: process.getgid!(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sc-ss-1",
            op: "session_send",
            auth: { kind: "operator_peercred" },
            payload: { session_id: targetId, message: "hello", silent: true },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal(calls.length, 1);

          const sc = calls[0].systemContext;
          assert.ok(sc, "systemContext must be present");
          assert.equal(sc.kind, "session.message");
          assert.ok(sc.summary.length > 0, "summary must be non-empty");
          assert.ok(sc.data, "data must be present");
          // Operator principal — sender info should be present
          assert.ok("sender_session_id" in sc.data! || "sender" in sc.data!, "data should identify the sender");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Session steer — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: session_steer", () => {
  it("passes systemContext with kind 'session.steer' and steered_by info", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sc-st-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const parentId = formatAgentSessionUrn("ag", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    const childId = formatAgentSessionUrn("ag", "discord", randomUUID());
    sessions.create({ id: parentId, workspacePath: "/wp", status: "active" });
    sessions.create({ id: childId, workspacePath: "/wc", status: "active" });
    sessions.update(childId, { parentSessionId: parentId, subagentMode: "persistent" });
    tokens.register(parentId, "tok-steer");

    const { ext, calls } = capturingSubagentRuntimeExtension();
    setSubagentRuntimeExtension(ext);
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid!(), gid: process.getgid!(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sc-st-1",
            op: "session_steer",
            auth: { kind: "agent", session_id: parentId, token: "tok-steer" },
            payload: { session_id: childId, prompt: "adjust behavior" },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal(calls.length, 1);

          const sc = calls[0].systemContext;
          assert.ok(sc, "systemContext must be present");
          assert.equal(sc.kind, "session.steer");
          assert.ok(sc.summary.length > 0, "summary must be non-empty");
          assert.ok(sc.data, "data must be present");
          assert.ok(sc.data!.steered_by, "data.steered_by must be present");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Fan-out completion notification — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: fan-out completion notification", () => {
  it("passes systemContext with kind 'fan_out.complete' on success", async () => {
    const captured = capturingRunSessionModelTurn();
    const notifier = createFanOutNotifier({
      getRunSessionModelTurn: () => captured.fn,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    });

    await notifier.notify("wf-123", true, { replyTo: "session-abc" });

    assert.equal(captured.calls.length, 1);
    const sc = captured.calls[0].systemContext;
    assert.ok(sc, "systemContext must be present");
    assert.equal(sc.kind, "fan_out.complete");
    assert.ok(sc.summary.length > 0, "summary must be non-empty");
    assert.ok(sc.summary.includes("successfully"), "summary should mention success");
    assert.ok(sc.data, "data must be present");
    assert.equal(sc.data!.workflow_id, "wf-123");
    assert.equal(sc.data!.success, true);
  });

  it("passes systemContext with kind 'fan_out.complete' on failure", async () => {
    const captured = capturingRunSessionModelTurn();
    const notifier = createFanOutNotifier({
      getRunSessionModelTurn: () => captured.fn,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    });

    await notifier.notify("wf-456", false, { replyTo: "session-def" });

    assert.equal(captured.calls.length, 1);
    const sc = captured.calls[0].systemContext;
    assert.ok(sc, "systemContext must be present");
    assert.equal(sc.kind, "fan_out.complete");
    assert.ok(sc.summary.includes("failures"), "summary should mention failures");
    assert.equal(sc.data!.workflow_id, "wf-456");
    assert.equal(sc.data!.success, false);
  });
});

// ---------------------------------------------------------------------------
// 6. Fan-out task spawning — systemContext
// ---------------------------------------------------------------------------

describe("systemContext adoption: fan-out task spawning", () => {
  it("passes systemContext with kind 'fan_out.task' and task data", async () => {
    const captured = capturingRunSessionModelTurn();
    const sessions = {
      update: () => {},
    };
    const sessionManager = {
      spawn: () => ({
        sessionId: "agent:main:discord:child-1",
        agentToken: "tok",
        agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
      }),
    };

    const adapter = createDaemonSpawnAdapter({
      sessionManager,
      sessions,
      parentSessionId: "agent:main:discord:abc",
      runSessionModelTurn: captured.fn,
    });

    await adapter.spawn({
      taskId: 42,
      prompt: "analyze data",
      replyTo: "agent:main:discord:abc",
      timeoutMs: 30_000,
      workflowId: "wf-789",
    });

    // Give the async fire-and-forget a tick
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(captured.calls.length, 1);
    const sc = captured.calls[0].systemContext;
    assert.ok(sc, "systemContext must be present");
    assert.equal(sc.kind, "fan_out.task");
    assert.ok(sc.summary.length > 0, "summary must be non-empty");
    assert.ok(sc.data, "data must be present");
    assert.equal(sc.data!.task_id, 42);
    assert.ok("workflow_id" in sc.data!, "data should include workflow_id");
  });
});
