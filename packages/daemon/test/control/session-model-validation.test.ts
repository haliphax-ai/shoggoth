/**
 * Phase 4 – RED tests: session_model op must validate model field format.
 *
 * When `model_selection.model` is provided, it must be in `providerId/model`
 * format (exactly one `/` with non-empty parts on both sides).
 * Bare names, leading-slash, and trailing-slash must be rejected with
 * ERR_INVALID_PAYLOAD.
 */
import { parseResponseLine, WIRE_VERSION } from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createConnection } from "node:net";
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";
import { startControlPlane } from "../../src/control/control-plane";
import { DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";

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
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-sm-val-"));
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

function setupDb(): { db: Database.Database; sessionId: string } {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  const sessions = createSessionStore(db);
  const sessionId = "test-session-model-val";
  sessions.create({ id: sessionId, workspacePath: "/w", status: "active" });
  return { db, sessionId };
}

describe("session_model model field format validation (Phase 4)", () => {
  it("accepts model_selection with valid providerId/model format", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-valid",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: { model: "anthropic/claude-3-5-sonnet" },
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `expected ok but got error: ${JSON.stringify(res.error)}`);
    });
    db.close();
  });

  it("rejects model_selection with bare model name (no slash)", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-bare",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: { model: "bare-name" },
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, false, "bare model name should be rejected");
      assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
    });
    db.close();
  });

  it("rejects model_selection with leading slash (empty provider)", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-no-provider",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: { model: "/no-provider" },
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, false, "model with empty provider should be rejected");
      assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
    });
    db.close();
  });

  it("rejects model_selection with trailing slash (empty model name)", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-no-model",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: { model: "provider/" },
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, false, "model with empty model name should be rejected");
      assert.equal(res.error?.code, "ERR_INVALID_PAYLOAD");
    });
    db.close();
  });

  it("accepts model_selection without model field (invocation-only update)", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-no-model-field",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: { temperature: 0.5 },
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `invocation-only update should succeed but got: ${JSON.stringify(res.error)}`);
    });
    db.close();
  });

  it("accepts model_selection: null (clearing)", async () => {
    if (process.platform !== "linux") return;
    const { db, sessionId } = setupDb();
    await withControlPlaneSession({ stateDb: db }, async (send) => {
      const line = await send({
        v: WIRE_VERSION,
        id: "sm-null",
        op: "session_model",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          session_id: sessionId,
          model_selection: null,
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `null model_selection should succeed but got: ${JSON.stringify(res.error)}`);
    });
    db.close();
  });
});
