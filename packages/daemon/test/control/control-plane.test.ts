import {
  ERR_PEERCRED_NOT_IMPLEMENTED,
  parseResponseLine,
  WIRE_VERSION,
} from "@shoggoth/authn";
import assert from "node:assert";
import Database from "better-sqlite3";
import { createConnection } from "node:net";
import { describe, it } from "node:test";
import { stat, mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { HealthRegistry } from "../../src/health";
import { createLogger } from "../../src/logging";
import { ShutdownCoordinator } from "../../src/shutdown";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AcpxSpawnFn } from "../../src/acpx/acpx-process-supervisor";
import { createSessionStore } from "../../src/sessions/session-store";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";
import { startControlPlane, type ReadPeerCredFn } from "../../src/control/control-plane";
import { DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";

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
      roleBypassUpTo: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [] },
    policy: DEFAULT_POLICY_CONFIG,
  };
}

function fakeChildProcess(pid: number): ChildProcess {
  const c = new EventEmitter() as ChildProcess;
  c.pid = pid;
  c.unref = () => {};
  return c;
}

async function jsonlRoundTrip(
  body: Record<string, unknown>,
  options?: {
    readPeerCred?: ReadPeerCredFn;
    stateDb?: Database.Database;
    config?: ShoggothConfig;
    acpxSpawn?: AcpxSpawnFn;
  },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-cp-"));
  const sock = join(dir, "c.sock");
  const config = options?.config ?? minimalConfig(sock);
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
    acpxSpawn: options?.acpxSpawn,
  });

  try {
    return await new Promise<string>((resolve, reject) => {
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
  } finally {
    await close();
  }
}

async function withControlPlaneSession(
  options: {
    readPeerCred?: ReadPeerCredFn;
    stateDb?: Database.Database;
    config?: ShoggothConfig;
    acpxSpawn?: AcpxSpawnFn;
    hitlPending?: ReturnType<typeof createPendingActionsStore>;
    cancelMcpHttpRequest?: (input: {
      sessionId: string;
      sourceId: string;
      requestId: number;
    }) => boolean;
  },
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-cp-"));
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
    readPeerCred: options.readPeerCred,
    stateDb: options.stateDb,
    acpxSpawn: options.acpxSpawn,
    hitlPending: options.hitlPending,
    cancelMcpHttpRequest: options.cancelMcpHttpRequest,
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

describe("control plane (unix socket + JSONL)", () => {
  it("returns ERR_PEERCRED_NOT_IMPLEMENTED when readPeerCred throws that code", async () => {
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "a1",
        op: "ping",
        auth: { kind: "operator_peercred" },
      },
      {
        readPeerCred: () => {
          const err = new Error("SO_PEERCRED unavailable in test") as NodeJS.ErrnoException;
          err.code = ERR_PEERCRED_NOT_IMPLEMENTED;
          throw err;
        },
      },
    );
    const res = parseResponseLine(line);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, ERR_PEERCRED_NOT_IMPLEMENTED);
    const details = res.error?.details as { followUp?: string } | undefined;
    assert.match(String(details?.followUp ?? ""), /SO_PEERCRED/);
  });

  it("ping succeeds with default readPeerCredFromSocket on Linux (native SO_PEERCRED)", async () => {
    if (process.platform !== "linux") return;

    const line = await jsonlRoundTrip({
      v: WIRE_VERSION,
      id: "native-peer",
      op: "ping",
      auth: { kind: "operator_peercred" },
    });
    const res = parseResponseLine(line);
    assert.deepStrictEqual(res, {
      v: WIRE_VERSION,
      id: "native-peer",
      ok: true,
      result: { pong: true },
    });
  });

  it("ping succeeds when readPeerCred is injected", async () => {
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "p1",
        op: "ping",
        auth: { kind: "operator_peercred" },
      },
      {
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: process.pid,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.deepStrictEqual(res, {
      v: WIRE_VERSION,
      id: "p1",
      ok: true,
      result: { pong: true },
    });
  });

  it("version and health ops return JSON", async () => {
    const vLine = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "v1",
        op: "version",
        auth: { kind: "operator_peercred" },
      },
      {
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const v = parseResponseLine(vLine);
    assert.equal(v.ok, true);
    assert.deepStrictEqual(v.result, { version: "test-0" });

    const hLine = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "h1",
        op: "health",
        auth: { kind: "operator_peercred" },
      },
      {
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const h = parseResponseLine(hLine);
    assert.equal(h.ok, true);
    assert.ok(h.result && typeof h.result === "object");
  });

  it("denies agent_ping for operator principal", async () => {
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "op1",
        op: "agent_ping",
        auth: { kind: "operator_peercred" },
      },
      {
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_FORBIDDEN");
  });

  it("denies ping for agent principal", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    sessions.create({ id: "ag-sess", workspacePath: "/w", status: "active" });
    const raw = "agent-secret-test";
    tokens.register("ag-sess", raw);
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "g1",
        op: "ping",
        auth: { kind: "agent", session_id: "ag-sess", token: raw },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_FORBIDDEN");
  });

  it("allows agent_ping with valid agent token and active session", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    sessions.create({ id: "ag-sess2", workspacePath: "/w", status: "active" });
    const raw = "agent-secret-test-2";
    tokens.register("ag-sess2", raw);
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "g2",
        op: "agent_ping",
        auth: { kind: "agent", session_id: "ag-sess2", token: raw },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.deepStrictEqual(res, {
      v: WIRE_VERSION,
      id: "g2",
      ok: true,
      result: { pong: true, session_id: "ag-sess2" },
    });
  });

  it("accepts operator_token matching operatorTokenPath secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shoggoth-op-tok-"));
    const sock = join(dir, "c.sock");
    const secretPath = join(dir, "op.secret");
    await writeFile(secretPath, "supersecret\n", "utf8");
    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      operatorTokenPath: secretPath,
    };
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "ot1",
        op: "ping",
        auth: { kind: "operator_token", token: "supersecret" },
      },
      {
        config,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.deepStrictEqual(res, {
      v: WIRE_VERSION,
      id: "ot1",
      ok: true,
      result: { pong: true },
    });
  });

  it("applies controlSocketMode (default 0o600)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shoggoth-mod-"));
    const socketPath = join(dir, "s.sock");
    const config = minimalConfig(socketPath);
    const logger = createLogger({ component: "test", minLevel: "error" });
    const shutdown = new ShutdownCoordinator({
      logger: logger.child({ subsystem: "shutdown" }),
      drainTimeoutMs: 5000,
    });
    const health = new HealthRegistry();
    const { close } = await startControlPlane({
      config,
      logger,
      shutdown,
      getHealth: () => health.snapshot(),
      version: "x",
      registerShutdownDrain: false,
      readPeerCred: () => ({
        uid: process.getuid(),
        gid: process.getgid(),
        pid: 0,
      }),
    });
    try {
      const st = await stat(socketPath);
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await close();
    }
  });

  it("denies control op when layered policy does not allow it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shoggoth-pol-deny-"));
    const sock = join(dir, "c.sock");
    const config: ShoggothConfig = {
      ...minimalConfig(sock),
      policy: {
        ...DEFAULT_POLICY_CONFIG,
        operator: {
          ...DEFAULT_POLICY_CONFIG.operator,
          controlOps: { allow: ["version", "health"], deny: [] },
        },
      },
    };
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "pd1",
        op: "ping",
        auth: { kind: "operator_peercred" },
      },
      {
        config,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "ERR_FORBIDDEN");
  });

  it("appends audit row on successful control invoke when stateDb is set", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const line = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "aud1",
        op: "ping",
        auth: { kind: "operator_peercred" },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 42,
        }),
      },
    );
    const res = parseResponseLine(line);
    assert.equal(res.ok, true);
    const row = db
      .prepare(
        `SELECT source, correlation_id, action, resource, outcome, peer_pid, principal_kind
         FROM audit_log WHERE correlation_id = ?`,
      )
      .get("aud1") as {
      source: string;
      correlation_id: string;
      action: string;
      resource: string;
      outcome: string;
      peer_pid: number;
      principal_kind: string;
    };
    assert.strictEqual(row.source, "cli_socket");
    assert.strictEqual(row.correlation_id, "aud1");
    assert.strictEqual(row.action, "authz.control");
    assert.strictEqual(row.resource, "ping");
    assert.strictEqual(row.outcome, "allowed");
    assert.strictEqual(row.peer_pid, 42);
    assert.strictEqual(row.principal_kind, "operator");
    db.close();
  });

  it("acpx_bind_set and canvas_authorize over control socket", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    sessions.create({ id: "canvas-sess", workspacePath: "/w", status: "active" });
    const tokens = createSqliteAgentTokenStore(db);
    const raw = "tok-canvas";
    tokens.register("canvas-sess", raw);

    const lineSet = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "acpx1",
        op: "acpx_bind_set",
        auth: { kind: "operator_peercred" },
        payload: {
          acp_workspace_root: "/acp/x",
          shoggoth_session_id: "canvas-sess",
          agent_principal_id: "sub-1",
        },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const setRes = parseResponseLine(lineSet);
    assert.equal(setRes.ok, true);

    const lineCan = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "cv1",
        op: "canvas_authorize",
        auth: { kind: "agent", session_id: "canvas-sess", token: raw },
        payload: {
          action: "canvas.push",
          resource_session_id: "canvas-sess",
        },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const can = parseResponseLine(lineCan);
    assert.deepStrictEqual(can.result, { allow: true });

    const lineDeny = await jsonlRoundTrip(
      {
        v: WIRE_VERSION,
        id: "cv2",
        op: "canvas_authorize",
        auth: { kind: "agent", session_id: "canvas-sess", token: raw },
        payload: {
          action: "canvas.push",
          resource_session_id: "other",
        },
      },
      {
        stateDb: db,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
    );
    const deny = parseResponseLine(lineDeny);
    assert.deepStrictEqual(deny.result, {
      allow: false,
      reason: "agent_cannot_touch_foreign_session_canvas",
    });

    db.close();
  });

  it("acpx_agent_start, list, stop with mocked spawn; audit lifecycle", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    sessions.create({ id: "acpx-sess", workspacePath: "/tmp/w", status: "active" });
    let nextPid = 60_000;
    const acpxSpawn: AcpxSpawnFn = () => fakeChildProcess(++nextPid);

    await withControlPlaneSession(
      {
        stateDb: db,
        acpxSpawn,
        readPeerCred: () => ({
          uid: process.getuid(),
          gid: process.getgid(),
          pid: 0,
        }),
      },
      async (send) => {
        const peer = { kind: "operator_peercred" } as const;

        const lineBind = await send({
          v: WIRE_VERSION,
          id: "b1",
          op: "acpx_bind_set",
          auth: peer,
          payload: {
            acp_workspace_root: "/acp/ws1",
            shoggoth_session_id: "acpx-sess",
            agent_principal_id: "p1",
          },
        });
        assert.equal(parseResponseLine(lineBind).ok, true);

        const lineStart = await send({
          v: WIRE_VERSION,
          id: "s1",
          op: "acpx_agent_start",
          auth: peer,
          payload: {
            acp_workspace_root: "/acp/ws1",
            acpx_args: ["openclaw", "exec", "noop"],
          },
        });
        const startRes = parseResponseLine(lineStart);
        assert.equal(startRes.ok, true);
        assert.equal((startRes.result as { pid: number }).pid, 60_001);

        const lineDup = await send({
          v: WIRE_VERSION,
          id: "s2",
          op: "acpx_agent_start",
          auth: peer,
          payload: {
            acp_workspace_root: "/acp/ws1",
            acpx_args: ["x"],
          },
        });
        const dupRes = parseResponseLine(lineDup);
        assert.equal(dupRes.ok, false);
        assert.equal(dupRes.error?.code, "ERR_ACPX_ALREADY_RUNNING");

        const lineList = await send({
          v: WIRE_VERSION,
          id: "l1",
          op: "acpx_agent_list",
          auth: peer,
          payload: {},
        });
        const listRes = parseResponseLine(lineList);
        assert.equal(listRes.ok, true);
        assert.equal((listRes.result as { processes: unknown[] }).processes.length, 1);

        const lineStop = await send({
          v: WIRE_VERSION,
          id: "t1",
          op: "acpx_agent_stop",
          auth: peer,
          payload: { acp_workspace_root: "/acp/ws1" },
        });
        const stopRes = parseResponseLine(lineStop);
        assert.equal(stopRes.ok, true);
        assert.deepStrictEqual(stopRes.result, { stopped: true, pid: 60_001 });
      },
    );

    const audits = db
      .prepare(`SELECT action, resource, outcome FROM audit_log WHERE action LIKE 'acpx.%' ORDER BY id`)
      .all() as { action: string; resource: string; outcome: string }[];
    assert.ok(audits.some((a) => a.action === "acpx.agent_start" && a.outcome === "ok"));
    assert.ok(audits.some((a) => a.action === "acpx.agent_stop" && a.outcome === "ok"));

    db.close();
  });

  it("hitl_pending_list / approve / get over control socket", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-hitl-cp-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const pending = createPendingActionsStore(db);
    pending.enqueue({
      id: "hp1",
      sessionId: "sess-x",
      toolName: "exec",
      payload: {},
      riskTier: "critical",
      expiresAtIso: "2099-01-01T00:00:00.000Z",
    });

    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
        stateDb: db,
        config: minimalConfig(sock),
        hitlPending: pending,
      },
      async (send) => {
        const peer = { kind: "operator_peercred" } as const;
        const lineList = await send({
          v: WIRE_VERSION,
          id: "hl1",
          op: "hitl_pending_list",
          auth: peer,
          payload: {},
        });
        const listRes = parseResponseLine(lineList);
        assert.equal(listRes.ok, true);
        const pend = (listRes.result as { pending: { id: string }[] }).pending;
        assert.equal(pend.length, 1);

        const lineApprove = await send({
          v: WIRE_VERSION,
          id: "ha1",
          op: "hitl_pending_approve",
          auth: peer,
          payload: { id: "hp1" },
        });
        const appRes = parseResponseLine(lineApprove);
        assert.equal(appRes.ok, true);
        assert.deepEqual(appRes.result, { ok: true });

        const lineGet = await send({
          v: WIRE_VERSION,
          id: "hg1",
          op: "hitl_pending_get",
          auth: peer,
          payload: { id: "hp1" },
        });
        const getRes = parseResponseLine(lineGet);
        assert.equal(getRes.ok, true);
        assert.equal((getRes.result as { row: { status: string } | null }).row?.status, "approved");

        pending.enqueue({
          id: "hp2",
          sessionId: "sess-x",
          toolName: "write",
          payload: {},
          riskTier: "caution",
          expiresAtIso: "2099-01-01T00:00:00.000Z",
        });
        const lineDeny = await send({
          v: WIRE_VERSION,
          id: "hd1",
          op: "hitl_pending_deny",
          auth: peer,
          payload: { id: "hp2" },
        });
        const denyRes = parseResponseLine(lineDeny);
        assert.equal(denyRes.ok, true);
        assert.deepEqual(denyRes.result, { ok: true });
        const lineGet2 = await send({
          v: WIRE_VERSION,
          id: "hg2",
          op: "hitl_pending_get",
          auth: peer,
          payload: { id: "hp2" },
        });
        const get2 = parseResponseLine(lineGet2);
        assert.equal(get2.ok, true);
        assert.equal((get2.result as { row: { status: string } | null }).row?.status, "denied");
      },
    );

    db.close();
  });

  it("mcp_http_cancel_request forwards to injected cancel hook", async () => {
    if (process.platform !== "linux") return;

    let seen: { sessionId: string; sourceId: string; requestId: number } | undefined;
    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 0 }),
        cancelMcpHttpRequest: (input) => {
          seen = input;
          return true;
        },
      },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "mc1",
          op: "mcp_http_cancel_request",
          auth: { kind: "operator_peercred" },
          payload: { session_id: "s1", source_id: "srv", request_id: 7 },
        });
        const res = parseResponseLine(line);
        assert.equal(res.ok, true);
        assert.deepStrictEqual(res.result, { cancelled: true });
      },
    );
    assert.deepStrictEqual(seen, { sessionId: "s1", sourceId: "srv", requestId: 7 });
  });
});
