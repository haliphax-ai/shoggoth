/**
 * Tests for the maxSpawnDepth nesting gate in the builtin `subagent` tool handler.
 *
 * Depth is computed by walking session lineage (parent_session_id), not URN
 * shape. Default config (maxSpawnDepth unset = 1): top-level sessions may use
 * subagent ops; subagents may not. The control-op layer re-checks the same gate
 * authoritatively on spawn (see test/control/subagent-spawn-nesting.test.ts).
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatAgentSessionUrn,
  mintSubagentSessionUrnFromParent,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSessionHandlers } from "../../src/sessions/builtin-handlers/session-handlers";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

interface InvokerCapture {
  calls: Array<{ sessionId: string; op: string; payload: unknown }>;
}

function stubCtx(
  db: Database.Database,
  sessionId: string,
  config: ShoggothConfig,
  capture: InvokerCapture,
): BuiltinToolContext {
  return {
    sessionId,
    db,
    config,
    env: {},
    workspacePath: "/tmp",
    workspaceRealPath: "/tmp",
    creds: { uid: process.getuid!(), gid: process.getgid!() },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => async (sid, op, payload) => {
      capture.calls.push({ sessionId: sid, op, payload });
      return { session_id: "child-session" };
    },
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: true,
  };
}

describe("subagent tool handler maxSpawnDepth gate", () => {
  let db: Database.Database;
  let dir: string;
  let topId: string;
  let capture: InvokerCapture;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagent-handler-nest-"));
    db = new Database(join(dir, "state.db"));
    migrate(db, defaultMigrationsDir());
    const sessions = createSessionStore(db);
    topId = formatAgentSessionUrn(
      "par",
      "discord",
      "channel",
      SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
    );
    sessions.create({ id: topId, workspacePath: dir, status: "active" });
    capture = { calls: [] };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function createSubagentRow(parentId: string): string {
    const sessions = createSessionStore(db);
    const id = mintSubagentSessionUrnFromParent(parentId);
    sessions.create({ id, workspacePath: dir, status: "active" });
    sessions.update(id, { parentSessionId: parentId });
    return id;
  }

  function createTopLevelRow(): string {
    const sessions = createSessionStore(db);
    const id = formatAgentSessionUrn("par", "discord", "channel", randomUUID());
    sessions.create({ id, workspacePath: dir, status: "active" });
    return id;
  }

  async function callTool(
    args: Record<string, unknown>,
    sessionId: string,
    config: ShoggothConfig,
  ): Promise<Record<string, unknown>> {
    const registry = new BuiltinToolRegistry();
    registerSessionHandlers(registry);
    const ctx = stubCtx(db, sessionId, config, capture);
    const result = await registry.execute("subagent", args, ctx);
    return JSON.parse(result.resultJson) as Record<string, unknown>;
  }

  async function callSpawn(
    sessionId: string,
    config: ShoggothConfig,
  ): Promise<Record<string, unknown>> {
    return callTool({ action: "spawn_one_shot", prompt: "task" }, sessionId, config);
  }

  it("default config: top-level session (depth 0) may spawn", async () => {
    const parsed = await callSpawn(topId, {} as ShoggothConfig);
    assert.equal(parsed.error, undefined);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]!.op, "subagent_spawn");
    assert.equal(capture.calls[0]!.sessionId, topId);
  });

  it("default config: subagent (depth 1) is denied", async () => {
    const childId = createSubagentRow(topId);
    const parsed = await callSpawn(childId, {} as ShoggothConfig);
    assert.equal(parsed.error, "subagent_tool_depth_exceeded");
    assert.equal(capture.calls.length, 0);
  });

  it("maxSpawnDepth 2: subagent (depth 1) may spawn", async () => {
    const childId = createSubagentRow(topId);
    const parsed = await callSpawn(childId, { maxSpawnDepth: 2 } as ShoggothConfig);
    assert.equal(parsed.error, undefined);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]!.op, "subagent_spawn");
  });

  it("maxSpawnDepth 2: depth-2 subagent is denied", async () => {
    const childId = createSubagentRow(topId);
    const grandchildId = createSubagentRow(childId);
    const parsed = await callSpawn(grandchildId, { maxSpawnDepth: 2 } as ShoggothConfig);
    assert.equal(parsed.error, "subagent_tool_depth_exceeded");
    assert.equal(capture.calls.length, 0);
  });

  it("per-agent maxSpawnDepth overrides top-level default", async () => {
    const childId = createSubagentRow(topId);
    const config = {
      agents: { list: { par: { maxSpawnDepth: 2 } } },
    } as unknown as ShoggothConfig;
    const parsed = await callSpawn(childId, config);
    assert.equal(parsed.error, undefined);
    assert.equal(capture.calls.length, 1);
  });

  it("maxSpawnDepth 0: top-level session is denied", async () => {
    const parsed = await callSpawn(topId, { maxSpawnDepth: 0 } as ShoggothConfig);
    assert.equal(parsed.error, "subagent_tool_depth_exceeded");
    assert.equal(capture.calls.length, 0);
  });

  it("unresolvable lineage (missing session row) degrades to deny", async () => {
    const ghost = formatAgentSessionUrn("par", "discord", "channel", randomUUID());
    // Not created in the sessions table.
    const parsed = await callSpawn(ghost, {} as ShoggothConfig);
    assert.equal(parsed.error, "subagent_tool_depth_exceeded");
    assert.equal(capture.calls.length, 0);
  });

  it("steer targets only direct children of the invoking session", async () => {
    const childId = createSubagentRow(topId);
    const strangerId = createTopLevelRow();

    const ok = await callTool(
      { action: "steer", session_id: childId, prompt: "go" },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(ok.error, undefined);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]!.op, "session_steer");

    const denied = await callTool(
      { action: "steer", session_id: strangerId, prompt: "go" },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(denied.error, "subagent_target_not_child");
    assert.equal(capture.calls.length, 1);
  });

  it("kill targets only direct children of the invoking session", async () => {
    const childId = createSubagentRow(topId);
    const strangerId = createTopLevelRow();

    const denied = await callTool(
      { action: "kill", session_id: strangerId },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(denied.error, "subagent_target_not_child");
    assert.equal(capture.calls.length, 0);

    const ok = await callTool({ action: "kill", session_id: childId }, topId, {} as ShoggothConfig);
    assert.equal(ok.error, undefined);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]!.op, "session_kill");
  });

  it("abort may target the session itself or a direct child", async () => {
    const childId = createSubagentRow(topId);
    const strangerId = createTopLevelRow();

    const self = await callTool(
      { action: "abort", session_id: topId },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(self.error, undefined);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]!.op, "session_abort");

    const child = await callTool(
      { action: "abort", session_id: childId },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(child.error, undefined);
    assert.equal(capture.calls.length, 2);

    const denied = await callTool(
      { action: "abort", session_id: strangerId },
      topId,
      {} as ShoggothConfig,
    );
    assert.equal(denied.error, "subagent_target_not_child");
    assert.equal(capture.calls.length, 2);
  });
});
