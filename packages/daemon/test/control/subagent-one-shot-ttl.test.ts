/**
 * One-shot subagent spawns carry an absolute wall-clock TTL instead of
 * `subagent_expires_at_ms: null`:
 * - an absent `ttl_minutes` resolves to `runtime.maxTtlMs`, a provided value is
 *   clamped to it, and the resolved deadline is persisted (never null),
 * - at expiry the child session is terminated and a structured
 *   `ERR_SUBAGENT_TTL_EXPIRED` failure is surfaced to the spawning session
 *   (foreground spawns settle the awaited op at the deadline rather than
 *   hanging past it; background spawns get an in-process delivery turn),
 * - a one-shot that completes before its deadline is unaffected.
 *
 * Persistence/clamp wiring goes through the control-plane socket like the
 * sibling inactivity tests; expiry semantics use fake timers against the
 * control op directly so no test sleeps through a minutes-scale window.
 */

import { describe, it, beforeAll, afterAll, afterEach, vi } from "vitest";

let sharedDir = "";
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => join(sharedDir, "templates"),
}));
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { WIRE_VERSION, parseResponseLine, type WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
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
import {
  handleIntegrationControlOp,
  IntegrationOpError,
  type IntegrationOpsContext,
} from "../../src/control/integration-ops";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import type { SessionAgentTurnResult } from "../../src/sessions/session-agent-turn";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";

const TTL_EXPIRED_CODE = "ERR_SUBAGENT_TTL_EXPIRED";
/** ttl_minutes is whole minutes; expiry tests use the smallest accepted TTL. */
const MIN_TTL_MS = 60_000;

let prevOperatorToken: string | undefined;
beforeAll(async () => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
  sharedDir = await mkdtemp(join(tmpdir(), "shoggoth-ost-shared-"));
});
afterAll(() => {
  if (prevOperatorToken === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  else process.env.SHOGGOTH_OPERATOR_TOKEN = prevOperatorToken;
});
afterEach(() => {
  vi.useRealTimers();
  setSubagentRuntimeExtension(undefined);
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
    mcp: { servers: {}, poolScope: "global" },
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
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-ost-"));
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

type SpawnOneShotResult = {
  session_id: string;
  mode: string;
  reply?: string;
};

async function spawnOneShot(
  db: Database.Database,
  config: ShoggothConfig,
  parentId: string,
  payload: Record<string, unknown>,
): Promise<SpawnOneShotResult> {
  let captured!: SpawnOneShotResult;

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
        id: "ost-1",
        op: "subagent_spawn",
        auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
        payload: {
          parent_session_id: parentId,
          prompt: "do the task",
          mode: "one_shot",
          agent_id: "ttl-agent",
          ...payload,
        },
      });
      const res = parseResponseLine(line);
      assert.equal(res.ok, true, `spawn failed: ${JSON.stringify(res.error)}`);
      captured = res.result as SpawnOneShotResult;
    });
  } finally {
    setSubagentRuntimeExtension(undefined);
  }

  return captured;
}

async function setupDb(): Promise<{
  db: Database.Database;
  config: ShoggothConfig;
  parentId: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-ost-"));
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

type CapturedTurn = {
  sessionId: string;
  userContent: string;
  userMetadata?: Record<string, unknown>;
};

/**
 * Runtime extension with captured turns. With `hangChildTurn`, the child's
 * one-shot turn never settles (a hung tool loop); the TTL-failure delivery
 * turn on the spawning session resolves with valid OOB structured output.
 */
function setCapturedExtension(opts: { hangChildTurn?: boolean } = {}): {
  turns: CapturedTurn[];
  posts: { sessionId: string; userContent: string }[];
} {
  const turns: CapturedTurn[] = [];
  const posts: { sessionId: string; userContent: string }[] = [];
  setSubagentRuntimeExtension({
    runSessionModelTurn: async (input) => {
      turns.push({
        sessionId: input.sessionId,
        userContent: input.userContent,
        ...(input.userMetadata ? { userMetadata: input.userMetadata } : {}),
      });
      if (opts.hangChildTurn && input.userMetadata?.subagent_one_shot === true) {
        return new Promise<SessionAgentTurnResult>(() => {});
      }
      if (input.userMetadata?.subagent_ttl_expired === true) {
        return {
          latestAssistantText: JSON.stringify({
            to_operator: `[${TTL_EXPIRED_CODE}] one-shot subagent terminated at its TTL`,
          }),
          failoverMeta: undefined,
        };
      }
      return { latestAssistantText: "REPLY", failoverMeta: undefined };
    },
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
    postToOperator: async (input) => {
      posts.push(input);
    },
  });
  return { turns, posts };
}

/** Direct control-op harness for fake-timer expiry tests. */
function makeDirectHarness(): {
  db: Database.Database;
  ctx: IntegrationOpsContext;
  parentId: string;
  config: ShoggothConfig;
} {
  const dir = join(sharedDir, `direct-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "state.db"));
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  const sessions = createSessionStore(db);
  const agentTokens = createSqliteAgentTokenStore(db);
  const sessionManager = createSessionManager({
    db,
    sessions,
    agentTokens,
    workspacesRoot: dir,
  });
  const parentId = formatAgentSessionUrn(
    "par",
    "discord",
    "channel",
    SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  );
  sessions.create({
    id: parentId,
    workspacePath: join(dir, "workspace"),
    status: "active",
  });
  const config = minimalConfig(dir);
  const ctx: IntegrationOpsContext = {
    config,
    stateDb: db,
    acpxStore: undefined,
    sessions,
    sessionManager,
    acpxSupervisor: undefined,
    recordIntegrationAudit: () => {},
  };
  return { db, ctx, parentId, config };
}

const operatorPrincipal: AuthenticatedPrincipal = {
  kind: "operator",
  operatorId: "test-operator",
  source: "token",
};

function makeSpawnRequest(parentId: string, payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: randomUUID(),
    op: "subagent_spawn",
    auth: { kind: "operator", token: "test" },
    payload: {
      parent_session_id: parentId,
      prompt: "do the task",
      mode: "one_shot",
      agent_id: "ttl-agent",
      ...payload,
    },
  };
}

describe("subagent_spawn one-shot wall-clock TTL", () => {
  it("persists a non-null deadline defaulting to runtime.maxTtlMs when ttl_minutes is absent", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const cappedConfig: ShoggothConfig = { ...config, runtime: { maxTtlMs: 300_000 } };

    const before = Date.now();
    const r = await spawnOneShot(db, cappedConfig, parentId, {});
    assert.equal(r.mode, "one_shot");

    const row = createSessionStore(db).getById(r.session_id);
    assert.ok(row);
    assert.equal(typeof row.subagentExpiresAtMs, "number");
    // Absent ttl_minutes resolves to runtime.maxTtlMs (300_000 ms).
    assert.ok(row.subagentExpiresAtMs! >= before + 300_000);
    assert.ok(row.subagentExpiresAtMs! <= Date.now() + 300_000);
    db.close();
  });

  it("clamps a provided ttl_minutes to runtime.maxTtlMs", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const cappedConfig: ShoggothConfig = { ...config, runtime: { maxTtlMs: 300_000 } };

    const before = Date.now();
    const r = await spawnOneShot(db, cappedConfig, parentId, { ttl_minutes: 100_000 });

    const row = createSessionStore(db).getById(r.session_id);
    assert.ok(row);
    // 100_000 minutes would be "forever"-ish; capped to 300_000 ms.
    assert.ok(row.subagentExpiresAtMs! >= before + 300_000);
    assert.ok(row.subagentExpiresAtMs! <= Date.now() + 300_000);
    db.close();
  });

  it("honors a provided ttl_minutes within the cap", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();

    const before = Date.now();
    const r = await spawnOneShot(db, config, parentId, { ttl_minutes: 2 });

    const row = createSessionStore(db).getById(r.session_id);
    assert.ok(row);
    assert.ok(row.subagentExpiresAtMs! >= before + 2 * 60_000);
    assert.ok(row.subagentExpiresAtMs! <= Date.now() + 2 * 60_000);
    db.close();
  });

  it("leaves a one-shot that completes before its deadline unaffected", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();

    const before = Date.now();
    const r = await spawnOneShot(db, config, parentId, { ttl_minutes: 5 });

    assert.equal(r.reply, "REPLY");
    const row = createSessionStore(db).getById(r.session_id);
    assert.ok(row);
    // Normal completion: terminated by the standard teardown, deadline still
    // persisted (and still in the future).
    assert.equal(row.status, "terminated");
    assert.equal(row.subagentMode, "one_shot");
    assert.ok(row.subagentExpiresAtMs! >= before + 5 * 60_000);
    db.close();
  });

  it("expiry of a background one-shot terminates it and delivers the structured failure to the spawning session", async () => {
    if (process.platform !== "linux") return;
    const { db, ctx, parentId } = makeDirectHarness();
    const ext = setCapturedExtension({ hangChildTurn: true });

    try {
      vi.useFakeTimers();
      const before = Date.now();
      const res = (await handleIntegrationControlOp(
        makeSpawnRequest(parentId, { background: true, ttl_minutes: 1 }),
        operatorPrincipal,
        ctx,
      )) as { session_id: string; background: boolean };
      assert.equal(res.background, true);

      const sessions = createSessionStore(db);
      const row = sessions.getById(res.session_id);
      assert.ok(row);
      assert.equal(typeof row.subagentExpiresAtMs, "number");
      assert.ok(row.subagentExpiresAtMs! >= before + MIN_TTL_MS);
      assert.ok(row.subagentExpiresAtMs! <= Date.now() + MIN_TTL_MS);
      assert.equal(row.status, "active");

      // The hung child outlives its deadline: the absolute clock fires.
      await vi.advanceTimersByTimeAsync(MIN_TTL_MS + 1_000);
      await vi.advanceTimersByTimeAsync(0);

      assert.equal(sessions.getById(res.session_id)?.status, "terminated");
      const failureTurn = ext.turns.find((t) => t.userMetadata?.subagent_ttl_expired === true);
      assert.ok(failureTurn, "expected a structured failure delivery to the spawning session");
      assert.equal(failureTurn.sessionId, parentId);
      assert.match(failureTurn.userContent, /ERR_SUBAGENT_TTL_EXPIRED/);
      assert.equal(failureTurn.userMetadata?.error, TTL_EXPIRED_CODE);
      assert.equal(failureTurn.userMetadata?.child_session_id, res.session_id);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("expiry of a foreground one-shot settles the awaited spawn with the structured failure instead of hanging", async () => {
    if (process.platform !== "linux") return;
    const { db, ctx, parentId } = makeDirectHarness();
    const ext = setCapturedExtension({ hangChildTurn: true });

    try {
      vi.useFakeTimers();
      const opPromise = handleIntegrationControlOp(
        makeSpawnRequest(parentId, { ttl_minutes: 1 }),
        operatorPrincipal,
        ctx,
      );
      // Mark the rejection handled immediately; it is awaited (and asserted)
      // below, but fake-timer advancement runs extra ticks before then.
      opPromise.catch(() => {});
      // Let the op arm the deadline, then drive past it: a hung foreground turn
      // must settle at the TTL with the structured error, not hang forever.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(MIN_TTL_MS + 1_000);
      await vi.advanceTimersByTimeAsync(0);

      let caught: unknown;
      try {
        await opPromise;
      } catch (e) {
        caught = e;
      }
      // Flush the OOB delivery chain kicked off by the expiry callback.
      await vi.advanceTimersByTimeAsync(0);
      assert.ok(
        caught instanceof IntegrationOpError,
        `expected IntegrationOpError, got ${String(caught)}`,
      );
      assert.equal(caught.code, TTL_EXPIRED_CODE);

      // The structured failure is also delivered to the spawning session.
      const failureTurn = ext.turns.find((t) => t.userMetadata?.subagent_ttl_expired === true);
      assert.ok(failureTurn, "expected a structured failure delivery to the spawning session");
      assert.equal(failureTurn.sessionId, parentId);
      assert.match(failureTurn.userContent, /ERR_SUBAGENT_TTL_EXPIRED/);

      const sessions = createSessionStore(db);
      const child = sessions
        .list({ parentSessionId: parentId })
        .find((c) => c.subagentMode === "one_shot");
      assert.ok(child, "expected a spawned one-shot child");
      assert.equal(child.status, "terminated");
      assert.equal(typeof child.subagentExpiresAtMs, "number");
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
});
