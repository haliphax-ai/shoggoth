import {
  ERR_PEERCRED_NOT_IMPLEMENTED,
  parseResponseLine,
  WIRE_VERSION,
} from "@shoggoth/authn";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
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
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { insertSessionToolAutoApprove } from "../../src/hitl/hitl-session-tool-auto-store";
import { createPendingActionsStore } from "../../src/hitl/pending-actions-store";
import { startControlPlane, type ReadPeerCredFn } from "../../src/control/control-plane";
import {
  DEFAULT_POLICY_CONFIG,
  formatAgentSessionUrn,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";

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
      agentToolAutoApprove: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
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

  it("session_context_new / session_context_reset (operator)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-segcx-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-cx", workspacePath: "/tmp/w", status: "active" });
    const seg1 = getSessionContextSegmentId(db, "sess-cx");
    const tr = createTranscriptStore(db);
    tr.append({ sessionId: "sess-cx", contextSegmentId: seg1, role: "user", content: "x" });
    insertSessionToolAutoApprove(db, "sess-cx", "builtin.write");
    const countSessionAutoApprove = () =>
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM hitl_session_tool_auto_approve WHERE session_id = ?`)
          .get("sess-cx") as { c: number }
      ).c;
    assert.equal(countSessionAutoApprove(), 1);

    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
        stateDb: db,
        config: minimalConfig(sock),
      },
      async (send) => {
        const peer = { kind: "operator_peercred" } as const;
        const lineNew = await send({
          v: WIRE_VERSION,
          id: "scn1",
          op: "session_context_new",
          auth: peer,
          payload: { session_id: "sess-cx" },
        });
        const newRes = parseResponseLine(lineNew);
        assert.equal(newRes.ok, true);
        const nr = newRes.result as {
          previousContextSegmentId: string;
          contextSegmentId: string;
          deletedRows: number;
        };
        assert.equal(nr.previousContextSegmentId, seg1);
        assert.notEqual(nr.contextSegmentId, seg1);
        assert.equal(nr.deletedRows, 1);
        assert.equal(countSessionAutoApprove(), 0);

        const nAll = db
          .prepare(`SELECT COUNT(*) AS c FROM transcript_messages WHERE session_id = ?`)
          .get("sess-cx") as { c: number };
        assert.equal(nAll.c, 0);

        const seg2 = getSessionContextSegmentId(db, "sess-cx");
        tr.append({ sessionId: "sess-cx", contextSegmentId: seg2, role: "user", content: "y" });
        insertSessionToolAutoApprove(db, "sess-cx", "builtin.write");
        assert.equal(countSessionAutoApprove(), 1);
        const lineReset = await send({
          v: WIRE_VERSION,
          id: "scr1",
          op: "session_context_reset",
          auth: peer,
          payload: { session_id: "sess-cx" },
        });
        const resetRes = parseResponseLine(lineReset);
        assert.equal(resetRes.ok, true);
        const rr = resetRes.result as { contextSegmentId: string; deletedRows: number };
        assert.equal(rr.deletedRows, 1);
        const nSeg2 = db
          .prepare(
            `SELECT COUNT(*) AS c FROM transcript_messages WHERE session_id = ? AND context_segment_id = ?`,
          )
          .get("sess-cx", seg2) as { c: number };
        assert.equal(nSeg2.c, 0);
        assert.equal(countSessionAutoApprove(), 1);
      },
    );

    db.close();
  });

  it("session_list (operator)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-slist-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-list-a", workspacePath: "/wa", status: "active" });
    createSessionStore(db).create({ id: "sess-list-z", workspacePath: "/wb", status: "terminated" });

    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
        stateDb: db,
        config: minimalConfig(sock),
      },
      async (send) => {
        const peer = { kind: "operator_peercred" } as const;
        const line = await send({
          v: WIRE_VERSION,
          id: "sl1",
          op: "session_list",
          auth: peer,
          payload: {},
        });
        const res = parseResponseLine(line);
        assert.equal(res.ok, true);
        const rows = (res.result as { sessions: { id: string; status: string }[] }).sessions;
        assert.ok(rows.length >= 2);
        assert.ok(rows.some((r) => r.id === "sess-list-a" && r.status === "active"));

        const lineF = await send({
          v: WIRE_VERSION,
          id: "sl2",
          op: "session_list",
          auth: peer,
          payload: { status: "terminated" },
        });
        const resF = parseResponseLine(lineF);
        assert.equal(resF.ok, true);
        const rowsF = (resF.result as { sessions: { id: string; status: string }[] }).sessions;
        assert.ok(rowsF.length >= 1);
        assert.ok(rowsF.every((r) => r.status === "terminated"));
        assert.ok(rowsF.some((r) => r.id === "sess-list-z"));
        assert.ok(!rowsF.some((r) => r.id === "sess-list-a"));

        const alfA = formatAgentSessionUrn("alf", "discord", randomUUID());
        const alfB = formatAgentSessionUrn("alf", "discord", randomUUID());
        const bobA = formatAgentSessionUrn("bob", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
        createSessionStore(db).create({ id: alfA, workspacePath: "/wa", status: "active" });
        createSessionStore(db).create({ id: alfB, workspacePath: "/wb", status: "active" });
        createSessionStore(db).create({ id: bobA, workspacePath: "/wc", status: "active" });

        const lineAg = await send({
          v: WIRE_VERSION,
          id: "sl3",
          op: "session_list",
          auth: peer,
          payload: { agent: "alf" },
        });
        const resAg = parseResponseLine(lineAg);
        assert.equal(resAg.ok, true);
        const rowsAg = (resAg.result as { sessions: { id: string }[] }).sessions;
        const idsAg = new Set(rowsAg.map((r) => r.id));
        assert.ok(idsAg.has(alfA));
        assert.ok(idsAg.has(alfB));
        assert.ok(!idsAg.has(bobA));
      },
    );

    db.close();
  });

  it("session_list (agent token, same agent id only)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-slist-ag-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const sidA = formatAgentSessionUrn("scoped", "discord", randomUUID());
    const sidB = formatAgentSessionUrn("scoped", "discord", randomUUID());
    const sidOther = formatAgentSessionUrn("other", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    sessions.create({ id: sidA, workspacePath: "/w1", status: "active" });
    sessions.create({ id: sidB, workspacePath: "/w2", status: "active" });
    sessions.create({ id: sidOther, workspacePath: "/w3", status: "active" });
    const raw = "tok-scoped-list";
    tokens.register(sidA, raw);

    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
        stateDb: db,
        config: minimalConfig(sock),
      },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "sla1",
          op: "session_list",
          auth: { kind: "agent", session_id: sidA, token: raw },
          payload: {},
        });
        const res = parseResponseLine(line);
        assert.equal(res.ok, true);
        const rows = (res.result as { sessions: { id: string }[] }).sessions;
        const ids = new Set(rows.map((r) => r.id));
        assert.ok(ids.has(sidA));
        assert.ok(ids.has(sidB));
        assert.ok(!ids.has(sidOther));
      },
    );

    db.close();
  });

  it("session_send (operator + mock runtime, silent)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-ssend-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const target = formatAgentSessionUrn("snd", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    createSessionStore(db).create({ id: target, workspacePath: "/w", status: "active" });

    let deliveryKind: string | undefined;
    setSubagentRuntimeExtension({
      runSessionModelTurn: async (input) => {
        deliveryKind = input.delivery.kind;
        return { latestAssistantText: "SEND_OK", failoverMeta: undefined };
      },
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const peer = { kind: "operator_peercred" } as const;
          const line = await send({
            v: WIRE_VERSION,
            id: "ss1",
            op: "session_send",
            auth: peer,
            payload: { session_id: target, message: "hello operator", silent: true },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal(deliveryKind, "internal");
          const body = res.result as { reply: string };
          assert.equal(body.reply, "SEND_OK");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }

    db.close();
  });

  it("session_send (agent token, same-agent ok; cross-agent needs agentToAgent)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-ssend-ag-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const sidA = formatAgentSessionUrn("scoped", "discord", randomUUID());
    const sidB = formatAgentSessionUrn("scoped", "discord", randomUUID());
    const sidOther = formatAgentSessionUrn("other", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    sessions.create({ id: sidA, workspacePath: "/w1", status: "active" });
    sessions.create({ id: sidB, workspacePath: "/w2", status: "active" });
    sessions.create({ id: sidOther, workspacePath: "/w3", status: "active" });
    const raw = "tok-ssend-agent";
    tokens.register(sidA, raw);

    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "AGENT_SEND_OK",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      const base = minimalConfig(sock);
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: base,
        },
        async (send) => {
          const auth = { kind: "agent", session_id: sidA, token: raw } as const;

          const okSame = await send({
            v: WIRE_VERSION,
            id: "ssa-same",
            op: "session_send",
            auth,
            payload: { session_id: sidB, message: "hi peer session", silent: true },
          });
          const resSame = parseResponseLine(okSame);
          assert.equal(resSame.ok, true);

          const badCross = await send({
            v: WIRE_VERSION,
            id: "ssa-deny",
            op: "session_send",
            auth,
            payload: { session_id: sidOther, message: "nope", silent: true },
          });
          const resDeny = parseResponseLine(badCross);
          assert.equal(resDeny.ok, false);
          assert.equal(resDeny.error?.code, "ERR_FORBIDDEN");
        },
      );

      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: { ...base, agentToAgent: { allow: ["other"] } },
        },
        async (send) => {
          const auth = { kind: "agent", session_id: sidA, token: raw } as const;
          const line = await send({
            v: WIRE_VERSION,
            id: "ssa-allow",
            op: "session_send",
            auth,
            payload: { session_id: sidOther, message: "cross ok", silent: true },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal((res.result as { reply: string }).reply, "AGENT_SEND_OK");
        },
      );

      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: {
            ...base,
            agents: { list: { scoped: { agentToAgent: { allow: ["*"] } } } },
          },
        },
        async (send) => {
          const auth = { kind: "agent", session_id: sidA, token: raw } as const;
          const line = await send({
            v: WIRE_VERSION,
            id: "ssa-star",
            op: "session_send",
            auth,
            payload: { session_id: sidOther, message: "star ok", silent: true },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }

    db.close();
  });

  it("subagent_spawn one_shot (operator + mock runtime)", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sub-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const parentId = formatAgentSessionUrn("par", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    createSessionStore(db).create({
      id: parentId,
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "gpt-parent", temperature: 0.1 },
    });

    let subscribed = 0;
    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "SUBAGENT_REPLY",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => {
        subscribed += 1;
        return () => {};
      },
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const peer = { kind: "operator_peercred" } as const;
          const line = await send({
            v: WIRE_VERSION,
            id: "sub1",
            op: "subagent_spawn",
            auth: peer,
            payload: {
              parent_session_id: parentId,
              prompt: "do the thing",
              mode: "one_shot",
            },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          const r = res.result as { session_id: string; reply: string; mode: string };
          assert.equal(r.mode, "one_shot");
          assert.equal(r.reply, "SUBAGENT_REPLY");
          assert.match(r.session_id, /^agent:par:discord:/);
          const child = createSessionStore(db).getById(r.session_id);
          assert.equal(child?.status, "terminated");
          assert.deepStrictEqual(child?.modelSelection, {
            model: "gpt-parent",
            temperature: 0.1,
          });

          const line2 = await send({
            v: WIRE_VERSION,
            id: "sub2",
            op: "subagent_spawn",
            auth: peer,
            payload: {
              parent_session_id: parentId,
              prompt: "overlay temp",
              mode: "one_shot",
              model_options: { temperature: 0.99 },
            },
          });
          const res2 = parseResponseLine(line2);
          assert.equal(res2.ok, true);
          const r2 = res2.result as { session_id: string };
          const child2 = createSessionStore(db).getById(r2.session_id);
          assert.deepStrictEqual(child2?.modelSelection, {
            model: "gpt-parent",
            temperature: 0.99,
          });
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    assert.equal(subscribed, 0);
    db.close();
  });

  it("subagent_spawn denied for agent when spawnSubagents false", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sub-spawn-off-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const parentId = formatAgentSessionUrn("par", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    sessions.create({
      id: parentId,
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "m", temperature: 0 },
    });
    tokens.register(parentId, "tok-spawn-off");
    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "noop",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: { ...minimalConfig(sock), spawnSubagents: false },
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sub-spawn-off",
            op: "subagent_spawn",
            auth: { kind: "agent", session_id: parentId, token: "tok-spawn-off" },
            payload: { parent_session_id: parentId, prompt: "task", mode: "one_shot" },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, false);
          assert.equal(res.error?.code, "ERR_FORBIDDEN");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });

  it("subagent_spawn denied for agent when subagentSpawnAllow excludes caller", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-sub-allow-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const parentId = formatAgentSessionUrn("par", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    sessions.create({
      id: parentId,
      workspacePath: "/tmp/w",
      status: "active",
      modelSelection: { model: "m", temperature: 0 },
    });
    tokens.register(parentId, "tok-allow-deny");
    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "noop",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: {
            ...minimalConfig(sock),
            subagentSpawnAllow: { allow: ["someone_else"] },
          },
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "sub-allow-deny",
            op: "subagent_spawn",
            auth: { kind: "agent", session_id: parentId, token: "tok-allow-deny" },
            payload: { parent_session_id: parentId, prompt: "task", mode: "one_shot" },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, false);
          assert.equal(res.error?.code, "ERR_FORBIDDEN");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });

  it("session_inspect denied for agent when spawnSubagents false", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-insp-off-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const sid = formatAgentSessionUrn("insp", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    sessions.create({ id: sid, workspacePath: "/w", status: "active" });
    tokens.register(sid, "tok-insp-off");
    await withControlPlaneSession(
      {
        readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
        stateDb: db,
        config: { ...minimalConfig(sock), spawnSubagents: false },
      },
      async (send) => {
        const line = await send({
          v: WIRE_VERSION,
          id: "insp-off",
          op: "session_inspect",
          auth: { kind: "agent", session_id: sid, token: "tok-insp-off" },
          payload: { session_id: sid },
        });
        const res = parseResponseLine(line);
        assert.equal(res.ok, false);
        assert.equal(res.error?.code, "ERR_FORBIDDEN");
      },
    );
    db.close();
  });

  it("session_steer allowed for agent on direct bound child", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-steer-ag-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const parentId = formatAgentSessionUrn("st", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    const childId = formatAgentSessionUrn("st", "discord", randomUUID());
    sessions.create({ id: parentId, workspacePath: "/wp", status: "active" });
    sessions.create({ id: childId, workspacePath: "/wc", status: "active" });
    sessions.update(childId, { parentSessionId: parentId, subagentMode: "bound" });
    tokens.register(parentId, "tok-steer-ag");
    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "STEER_OK",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "steer-ag",
            op: "session_steer",
            auth: { kind: "agent", session_id: parentId, token: "tok-steer-ag" },
            payload: { session_id: childId, prompt: "continue" },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, true);
          assert.equal((res.result as { reply: string }).reply, "STEER_OK");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
    db.close();
  });

  it("session_steer denied for agent when target is not a direct child", async () => {
    if (process.platform !== "linux") return;

    const dir = await mkdtemp(join(tmpdir(), "shoggoth-steer-bad-"));
    const sock = join(dir, "c.sock");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    const tokens = createSqliteAgentTokenStore(db);
    const callerId = formatAgentSessionUrn("caller", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    const otherParent = formatAgentSessionUrn("otherp", "discord", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
    const childId = formatAgentSessionUrn("otherp", "discord", randomUUID());
    sessions.create({ id: callerId, workspacePath: "/w1", status: "active" });
    sessions.create({ id: otherParent, workspacePath: "/w2", status: "active" });
    sessions.create({ id: childId, workspacePath: "/w3", status: "active" });
    sessions.update(childId, { parentSessionId: otherParent, subagentMode: "bound" });
    tokens.register(callerId, "tok-steer-bad");
    setSubagentRuntimeExtension({
      runSessionModelTurn: async () => ({
        latestAssistantText: "should not run",
        failoverMeta: undefined,
      }),
      subscribeSubagentSession: () => () => {},
      registerDiscordThreadBinding: () => () => {},
    });
    try {
      await withControlPlaneSession(
        {
          readPeerCred: () => ({ uid: process.getuid(), gid: process.getgid(), pid: 1 }),
          stateDb: db,
          config: minimalConfig(sock),
        },
        async (send) => {
          const line = await send({
            v: WIRE_VERSION,
            id: "steer-bad",
            op: "session_steer",
            auth: { kind: "agent", session_id: callerId, token: "tok-steer-bad" },
            payload: { session_id: childId, prompt: "nope" },
          });
          const res = parseResponseLine(line);
          assert.equal(res.ok, false);
          assert.equal(res.error?.code, "ERR_FORBIDDEN");
        },
      );
    } finally {
      setSubagentRuntimeExtension(undefined);
    }
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
