/**
 * `subagent_spawn` (persistent) vs. the thread-subagent autocreate routine: the spawn op
 * pre-claims its target thread so a concurrent THREAD_CREATE event cannot race it for the
 * binding, and when a freshly autocreated, zero-turn banner-only session already holds
 * the thread it is ADOPTED — the spawn prompt becomes its first model turn, its own child
 * is discarded, and the claim is released on every exit path. Genuine conflicts (a live,
 * non-adoptable holder) still fail cleanly with the child cleaned up.
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
import { clearAllPersistentSubagentInactivityTimers } from "../../src/subagent/persistent-subagent-timers";
import { rememberSubagentHandles } from "../../src/subagent/subagent-disposables";
import {
  clearThreadSpawnClaims,
  isThreadClaimedByControlPlaneSpawn,
} from "../../src/subagent/thread-subagent-claims";
import { startControlPlane } from "../../src/control/control-plane";
import { createLogger } from "../../src/logging";
import { HealthRegistry } from "../../src/health";
import { ShutdownCoordinator } from "../../src/shutdown";

let prevOperatorToken: string | undefined;
beforeAll(async () => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = "test-op-token";
  sharedDir = await mkdtemp(join(tmpdir(), "shoggoth-spr-shared-"));
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
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-spr-"));
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

type CapturedTurn = {
  readonly sessionId: string;
  readonly userContent: string;
};

type SpawnResult = {
  readonly session_id: string;
  readonly platform_thread_id: string | null;
  readonly adopted_session_id?: string;
};

/**
 * Runtime extension stub with the full thread-bound spawn surface: a binding map that
 * rejects registrations for threads it does not own (mirroring the platform), captured
 * model turns, and an auto-create REST stub.
 */
function makeStubExt(input: {
  readonly boundThreads: Map<string, string>;
  readonly turns: Array<CapturedTurn>;
  readonly banners: Array<{ sessionId: string; body: string }>;
  /** Force every registration to throw (simulates a race lost to a concurrent flow). */
  readonly rejectAllBindings?: boolean;
  readonly createdThreadId?: string;
}) {
  let turnCount = 0;
  return {
    runSessionModelTurn: async (t: { sessionId: string; userContent: string }) => {
      input.turns.push({ sessionId: t.sessionId, userContent: t.userContent });
      turnCount++;
      return { latestAssistantText: `REPLY ${turnCount}`, failoverMeta: undefined };
    },
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: (threadId: string, sessionId: string) => {
      if (input.rejectAllBindings) throw new Error(`Discord thread ${threadId} already bound`);
      const current = input.boundThreads.get(threadId.trim());
      if (current !== undefined && current !== sessionId) {
        throw new Error(`Discord thread ${threadId} already bound to session ${current}`);
      }
      input.boundThreads.set(threadId.trim(), sessionId.trim());
      return () => {};
    },
    createThread: async () => ({ id: input.createdThreadId ?? "thread-created" }),
    resolveOutboundChannelIdForSession: () => "chan-out",
    sendStatusMessage: async (sessionId: string, body: string) => {
      input.banners.push({ sessionId, body });
    },
  };
}

async function setupDb(): Promise<{
  db: Database.Database;
  config: ShoggothConfig;
  parentId: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "shoggoth-spr-"));
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

async function sendSpawn(
  db: Database.Database,
  config: ShoggothConfig,
  parentId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; result: SpawnResult } | { ok: false; code: string; message: string }> {
  let outcome!: { ok: boolean; error?: { code?: string; message?: string }; result?: SpawnResult };
  await withControlPlaneSession({ stateDb: db, config }, async (send) => {
    const line = await send({
      v: WIRE_VERSION,
      id: "spr-1",
      op: "subagent_spawn",
      auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
      payload: {
        parent_session_id: parentId,
        prompt: "monitor ci",
        mode: "persistent",
        agent_id: "spr-agent",
        ...payload,
      },
    });
    outcome = parseResponseLine(line) as typeof outcome;
  });
  if (outcome.ok) return { ok: true, result: outcome.result! };
  return { ok: false, code: outcome.error?.code ?? "", message: outcome.error?.message ?? "" };
}

/** Insert a zero-turn, banner-only thread subagent session as the autocreate routine would. */
function insertAutocreatedSession(input: {
  readonly db: Database.Database;
  readonly parentId: string;
  readonly threadId: string;
}): string {
  const sessions = createSessionStore(input.db);
  const adoptedId = formatAgentSessionUrn(
    "autocreated",
    "discord",
    "thread",
    SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  );
  sessions.create({
    id: adoptedId,
    workspacePath: join(sharedDir, "workspace-adopted"),
    status: "active",
  });
  sessions.update(adoptedId, {
    parentSessionId: input.parentId,
    subagentMode: "persistent",
    subagentPlatformThreadId: input.threadId,
  });
  // The autocreate routine registers its runtime handles (binding + bus + TTL).
  rememberSubagentHandles(adoptedId, {
    unregisterThread: () => {},
    unsubscribeBus: () => {},
    clearTtl: () => {},
  });
  return adoptedId;
}

describe("subagent_spawn thread race", () => {
  afterEach(() => {
    clearAllPersistentSubagentInactivityTimers();
    clearThreadSpawnClaims();
    setSubagentRuntimeExtension(undefined);
  });

  it("adopts a fresh zero-turn autocreated session and delivers the prompt as its first turn", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const threadId = "555";
    const boundThreads = new Map<string, string>();
    const turns: Array<CapturedTurn> = [];
    const banners: Array<{ sessionId: string; body: string }> = [];
    // The autocreate routine won the thread milliseconds earlier: it holds the binding
    // and its session is banner-only (zero transcript messages).
    const adoptedId = insertAutocreatedSession({ db, parentId, threadId });
    boundThreads.set(threadId, adoptedId);
    const ext = makeStubExt({ boundThreads, turns, banners });

    setSubagentRuntimeExtension(ext as never);
    const res = await sendSpawn(db, config, parentId, { platform_thread_id: threadId });
    assert.equal(res.ok, true, JSON.stringify(res));
    const result = (res as { result: SpawnResult }).result;

    // The adopted session IS the thread's session of record.
    assert.equal(result.session_id, adoptedId);
    assert.equal(result.adopted_session_id, adoptedId);
    assert.equal(result.platform_thread_id, threadId);

    // The spawn's own child must not linger as an orphan claiming the thread.
    const store = createSessionStore(db);
    const all = store.list();
    const threadHolders = all.filter((s) => s.subagentPlatformThreadId === threadId);
    assert.equal(threadHolders.length, 1);
    assert.equal(threadHolders[0].id, adoptedId);
    assert.equal(threadHolders[0].status, "active");
    const spawnOwnChildren = all.filter(
      (s) => s.parentSessionId === parentId && s.id !== adoptedId,
    );
    assert.ok(spawnOwnChildren.length >= 1);
    assert.ok(spawnOwnChildren.every((s) => s.status === "terminated"));

    // The spawn prompt is delivered as the adopted session's first model turn.
    await vi.waitFor(() => assert.ok(turns.length >= 1, "first turn fired"), { timeout: 3000 });
    assert.equal(turns[0].sessionId, adoptedId);
    assert.equal(turns[0].userContent, "monitor ci");
    // No duplicate banner: the autocreate routine posted it, the spawn op skips it.
    assert.equal(banners.length, 0);

    // Claim released on success.
    assert.equal(isThreadClaimedByControlPlaneSpawn({ threadId, parentChannelId: "" }), false);
    db.close();
  });

  it("a genuine conflict (non-adoptable live holder) fails cleanly and releases the claim", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const threadId = "666";
    const turns: Array<CapturedTurn> = [];
    const banners: Array<{ sessionId: string; body: string }> = [];
    const ext = makeStubExt({
      boundThreads: new Map(),
      turns,
      banners,
      rejectAllBindings: true,
    });

    setSubagentRuntimeExtension(ext as never);
    const res = await sendSpawn(db, config, parentId, { platform_thread_id: threadId });
    assert.equal(res.ok, false);
    const err = res as { code: string; message: string };
    assert.equal(err.code, "ERR_INVALID_PAYLOAD");
    assert.match(err.message, /already bound to another active session/);

    // No orphan: the spawn's own child was terminated.
    const store = createSessionStore(db);
    const children = store.list().filter((s) => s.parentSessionId === parentId);
    assert.ok(children.length >= 1);
    assert.ok(children.every((s) => s.status === "terminated"));
    assert.equal(turns.length, 0);

    // Claim released on the failure path — the thread is not permanently poisoned.
    assert.equal(isThreadClaimedByControlPlaneSpawn({ threadId, parentChannelId: "" }), false);
    db.close();
  });

  it('thread_id "0" auto-create succeeds, delivers the prompt, and releases both claims', async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const boundThreads = new Map<string, string>();
    const turns: Array<CapturedTurn> = [];
    const banners: Array<{ sessionId: string; body: string }> = [];
    const ext = makeStubExt({ boundThreads, turns, banners, createdThreadId: "thread-new" });

    setSubagentRuntimeExtension(ext as never);
    const res = await sendSpawn(db, config, parentId, { platform_thread_id: "0" });
    assert.equal(res.ok, true, JSON.stringify(res));
    const result = (res as { result: SpawnResult }).result;
    assert.equal(result.platform_thread_id, "thread-new");
    assert.equal(boundThreads.get("thread-new"), result.session_id);

    await vi.waitFor(() => assert.ok(turns.length >= 1, "first turn fired"), { timeout: 3000 });
    assert.equal(turns[0].sessionId, result.session_id);
    assert.equal(turns[0].userContent, "monitor ci");
    // The spawn posted its own creation banner (no autocreate ran for this thread).
    assert.equal(banners.length, 1);

    // Pending-creation claim (by channel) and explicit id claim both released.
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "thread-new", parentChannelId: "chan-out" }),
      false,
    );
    db.close();
  });

  it("a spawn on an unclaimed thread binds its own session as before", async () => {
    if (process.platform !== "linux") return;
    const { db, config, parentId } = await setupDb();
    const threadId = "777";
    const boundThreads = new Map<string, string>();
    const turns: Array<CapturedTurn> = [];
    const banners: Array<{ sessionId: string; body: string }> = [];
    const ext = makeStubExt({ boundThreads, turns, banners });

    setSubagentRuntimeExtension(ext as never);
    const res = await sendSpawn(db, config, parentId, { platform_thread_id: threadId });
    assert.equal(res.ok, true, JSON.stringify(res));
    const result = (res as { result: SpawnResult }).result;
    assert.equal(result.adopted_session_id, undefined);
    assert.equal(boundThreads.get(threadId), result.session_id);
    await vi.waitFor(() => assert.ok(turns.length >= 1, "first turn fired"), { timeout: 3000 });
    assert.equal(turns[0].sessionId, result.session_id);
    assert.equal(banners.length, 1);
    assert.equal(isThreadClaimedByControlPlaneSpawn({ threadId, parentChannelId: "" }), false);
    db.close();
  });
});
