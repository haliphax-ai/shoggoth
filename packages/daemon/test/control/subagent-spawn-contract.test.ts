/**
 * Contract mode on the subagent_spawn control op (one-shot):
 * - contract targets must be inside a git repository at call time (spawn fails)
 * - after the turn, the response carries an extra `contract` verdict field
 * - structural breaks skip the decision model entirely
 * - `judge` selects the decision model and must be a configured provider/model
 * - contract is rejected for persistent spawns; an empty contract is a no-op
 */

import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";

let sharedDir = "";
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => join(sharedDir, "templates"),
}));

const { mockEvaluate } = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
}));
vi.mock("../../src/decision/decision-service", () => ({
  DecisionService: {
    fromConfig: vi.fn(() => ({ evaluate: mockEvaluate })),
  },
}));

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

const TEST_OPERATOR_TOKEN = "test-op-token";

let prevOperatorToken: string | undefined;
beforeEach(() => {
  prevOperatorToken = process.env.SHOGGOTH_OPERATOR_TOKEN;
  process.env.SHOGGOTH_OPERATOR_TOKEN = TEST_OPERATOR_TOKEN;
  sharedDir = "";
  mockEvaluate.mockReset();
});
afterEach(() => {
  if (prevOperatorToken === undefined) delete process.env.SHOGGOTH_OPERATOR_TOKEN;
  else process.env.SHOGGOTH_OPERATOR_TOKEN = prevOperatorToken;
  setSubagentRuntimeExtension(undefined);
});

function minimalConfig(dir: string): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: join(dir, "state.db"),
    socketPath: join(dir, "c.sock"),
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
    decision: {
      providers: {
        "typesafe-main": {
          kind: "typesafe",
          baseUrl: "https://typesafe.test",
          apiKey: "k",
          models: { "jev-latest": {} },
        },
      },
    },
  } as ShoggothConfig;
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitFixtureEnv(),
  });
}

/** Strips hook/CI git env so fixture repos resolve by cwd, not GIT_DIR. */
function gitFixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@test.local",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@test.local",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spawn-contract-repo-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.local");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "baseline");
  return dir;
}

async function withControlPlaneSession(
  config: ShoggothConfig,
  db: Database.Database,
  fn: (send: (body: Record<string, unknown>) => Promise<string>) => Promise<void>,
): Promise<void> {
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
    stateDb: db,
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

interface SpawnFixture {
  db: Database.Database;
  parentId: string;
  repoDir: string;
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(withRepo = true): Promise<SpawnFixture> {
  const dir = await mkdtemp(join(tmpdir(), "spawn-contract-"));
  const db = new Database(join(dir, "state.db"));
  migrate(db, defaultMigrationsDir());
  const repoDir = withRepo ? await makeRepo() : dir;
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
  // working_directory drives contract path resolution at spawn time
  db.prepare("UPDATE sessions SET working_directory = ? WHERE id = ?").run(repoDir, parentId);

  return {
    db,
    parentId,
    repoDir,
    dir,
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
      if (withRepo) await rm(repoDir, { recursive: true, force: true });
    },
  };
}

type TurnHook = (input: { sessionId: string; userContent: string }) => void | Promise<void>;

function installRuntime(hook?: TurnHook): { turns: number } {
  const state = { turns: 0 };
  setSubagentRuntimeExtension({
    runSessionModelTurn: async (input) => {
      state.turns += 1;
      await hook?.(input as { sessionId: string; userContent: string });
      return { latestAssistantText: "REPLY", failoverMeta: undefined };
    },
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
  });
  return state;
}

async function spawn(
  config: ShoggothConfig,
  db: Database.Database,
  parentId: string,
  payload: Record<string, unknown>,
): Promise<ReturnType<typeof parseResponseLine>> {
  let parsed: ReturnType<typeof parseResponseLine> | undefined;
  await withControlPlaneSession(config, db, async (send) => {
    const line = await send({
      v: WIRE_VERSION,
      id: "contract-1",
      op: "subagent_spawn",
      auth: { kind: "operator_token", token: TEST_OPERATOR_TOKEN },
      payload: {
        parent_session_id: parentId,
        prompt: "test task",
        mode: "one_shot",
        agent_id: "ct-agent",
        ...payload,
      },
    });
    parsed = parseResponseLine(line);
  });
  return parsed!;
}

const CONTRACT = [{ path: "a.txt", action: "update", summary: "append a line to a.txt" }];

describe("subagent_spawn contract mode", () => {
  it("fails the spawn when a contract target is not in a git repository", async () => {
    const fx = await makeFixture(false);
    try {
      const state = installRuntime();
      mockEvaluate.mockResolvedValue({
        status: "complete",
        model: "jev-latest",
        answers: { contract_0: { noul: 0.99 } },
      });
      const res = await spawn(minimalConfig(fx.dir), fx.db, fx.parentId, {
        contract: CONTRACT,
      });
      // config built against a throwaway dir — rebuild with fixture dir instead
      assert.ok(res);
      // Either the config path or the spawn error: the repo check must fail.
      if (res.ok) {
        assert.fail("spawn must fail outside a git repository");
      }
      const msg = String((res.error as Record<string, unknown>)?.message ?? res.error ?? "");
      assert.match(msg, /not in a git repository/);
      assert.equal(state.turns, 0, "no model turn must run");
    } finally {
      await fx.cleanup();
    }
  });

  it("returns a fulfilled contract verdict after a judged turn", async () => {
    const fx = await makeFixture();
    try {
      const state = installRuntime(async () => {
        await writeFile(join(fx.repoDir, "a.txt"), "one\ntwo\n");
      });
      mockEvaluate.mockResolvedValue({
        status: "complete",
        model: "jev-latest",
        answers: { contract_0: { noul: 0.99 } },
      });
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: CONTRACT,
      });
      assert.ok(res.ok, JSON.stringify(res.error));
      const contract = (res.result as { contract?: { fulfilled?: boolean; judged?: unknown[] } })
        .contract;
      assert.ok(contract, "contract verdict must be on the spawn response");
      assert.equal(contract.fulfilled, true);
      assert.equal(state.turns, 1);
      // The decision model must have been asked a noul question in one batch.
      assert.equal(mockEvaluate.mock.calls.length, 1);
      const evaluateReq = mockEvaluate.mock.calls[0][0] as {
        questions: Record<string, unknown>;
      };
      assert.equal(Object.keys(evaluateReq.questions).length, 1);
      assert.equal((evaluateReq.questions.contract_0 as { type: string }).type, "noul");
    } finally {
      await fx.cleanup();
    }
  });

  it("breaks the contract without consulting the decision model when nothing changed", async () => {
    const fx = await makeFixture();
    try {
      installRuntime(); // no mutation
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: CONTRACT,
      });
      assert.ok(res.ok, JSON.stringify(res.error));
      const contract = (
        res.result as {
          contract?: { fulfilled?: boolean; broken?: boolean; violated?: string[] };
        }
      ).contract;
      assert.ok(contract);
      assert.equal(contract.fulfilled, false);
      assert.equal(contract.broken, true);
      assert.deepEqual(contract.violated, ["a.txt"]);
      assert.equal(mockEvaluate.mock.calls.length, 0, "decision must not run");
    } finally {
      await fx.cleanup();
    }
  });

  it("fails the judge below the configured yesMinimum", async () => {
    const fx = await makeFixture();
    try {
      installRuntime(async () => {
        await writeFile(join(fx.repoDir, "a.txt"), "one\ntwo\n");
      });
      mockEvaluate.mockResolvedValue({
        status: "complete",
        model: "jev-latest",
        answers: { contract_0: { noul: 0.5 } },
      });
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: CONTRACT,
      });
      assert.ok(res.ok, JSON.stringify(res.error));
      const contract = (res.result as { contract?: { fulfilled?: boolean } }).contract;
      assert.ok(contract);
      assert.equal(contract.fulfilled, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("passes the per-spawn judge model through to the decision call", async () => {
    const fx = await makeFixture();
    try {
      installRuntime(async () => {
        await writeFile(join(fx.repoDir, "a.txt"), "one\ntwo\n");
      });
      mockEvaluate.mockResolvedValue({
        status: "complete",
        model: "jev-latest",
        answers: { contract_0: { noul: 0.95 } },
      });
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: CONTRACT,
        judge: "typesafe-main/jev-latest",
      });
      assert.ok(res.ok, JSON.stringify(res.error));
      assert.equal(mockEvaluate.mock.calls.length, 1);
      const evaluateReq = mockEvaluate.mock.calls[0][0] as { model?: string };
      assert.equal(evaluateReq.model, "typesafe-main/jev-latest");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects an unknown judge model at call time", async () => {
    const fx = await makeFixture();
    try {
      installRuntime();
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: CONTRACT,
        judge: "typesafe-main/nope",
      });
      assert.equal(res.ok, false);
      const msg = String((res.error as Record<string, unknown>)?.message ?? res.error ?? "");
      assert.match(msg, /judge model is not a configured decision provider\/model/);
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects judge without a contract", async () => {
    const fx = await makeFixture();
    try {
      installRuntime();
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        judge: "typesafe-main/jev-latest",
      });
      assert.equal(res.ok, false);
      const msg = String((res.error as Record<string, unknown>)?.message ?? res.error ?? "");
      assert.match(msg, /judge requires a non-empty contract/);
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects a contract on persistent spawns", async () => {
    const fx = await makeFixture();
    try {
      installRuntime();
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        mode: "persistent",
        contract: CONTRACT,
      });
      assert.equal(res.ok, false);
      const msg = String((res.error as Record<string, unknown>)?.message ?? res.error ?? "");
      assert.match(msg, /one_shot/);
    } finally {
      await fx.cleanup();
    }
  });

  it("treats an empty contract as mode-inactive (no contract field)", async () => {
    const fx = await makeFixture();
    try {
      installRuntime();
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {
        contract: [],
      });
      assert.ok(res.ok, JSON.stringify(res.error));
      const result = res.result as Record<string, unknown>;
      assert.equal("contract" in result, false, "empty contract must be a no-op");
      assert.equal(mockEvaluate.mock.calls.length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not activate contract mode when the field is absent", async () => {
    const fx = await makeFixture();
    try {
      installRuntime();
      const res = await spawn(minimalConfig(fx.repoDir), fx.db, fx.parentId, {});
      assert.ok(res.ok, JSON.stringify(res.error));
      const result = res.result as Record<string, unknown>;
      assert.equal("contract" in result, false);
    } finally {
      await fx.cleanup();
    }
  });
});
