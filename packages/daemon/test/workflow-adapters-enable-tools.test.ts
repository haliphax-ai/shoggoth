import { describe, it } from "vitest";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createDaemonSpawnAdapter, type DaemonSpawnAdapterDeps } from "../src/workflow-adapters.js";
import { getSessionToolState } from "../src/sessions/session-tool-discovery";

function makeStateDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tool_state (
      session_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (session_id, tool_id)
    )
  `);
  return db;
}

const PARENT = "agent:main:discord:channel:abc";

function makeAdapterDeps(db: Database.Database): DaemonSpawnAdapterDeps & {
  spawned: string[];
} {
  const spawned: string[] = [];
  const sessionManager = {
    spawn: async () => {
      const sessionId = `agent:main:discord:channel:abc:child-${spawned.length + 1}`;
      spawned.push(sessionId);
      return { sessionId, agentToken: "tok", agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const };
    },
    kill: () => {},
  };
  const sessions = {
    getById: () => undefined,
    update: () => {},
  } as unknown as DaemonSpawnAdapterDeps["sessions"];
  return {
    sessionManager,
    sessions,
    parentSessionId: PARENT,
    stateDb: db,
    runSessionModelTurn: async () => ({ latestAssistantText: "done" }),
    spawned,
  };
}

describe("createDaemonSpawnAdapter enableTools", () => {
  it("records exact IDs and globs for the spawned task session", async () => {
    const db = makeStateDb();
    const deps = makeAdapterDeps(db);
    const adapter = createDaemonSpawnAdapter(deps);

    await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: PARENT,
      timeoutMs: 30_000,
      enableTools: ["kanban-*", "builtin-exec"],
    });

    assert.equal(deps.spawned.length, 1);
    const state = getSessionToolState(db, deps.spawned[0]);
    assert.equal(state.get("kanban-*"), true);
    assert.equal(state.get("builtin-exec"), true);
    db.close();
  });

  it("writes no state when enableTools is absent", async () => {
    const db = makeStateDb();
    const deps = makeAdapterDeps(db);
    const adapter = createDaemonSpawnAdapter(deps);

    await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: PARENT,
      timeoutMs: 30_000,
    });

    assert.equal(getSessionToolState(db, deps.spawned[0]).size, 0);
    db.close();
  });

  it("writes no state when the adapter has no stateDb", async () => {
    const db = makeStateDb();
    const deps = makeAdapterDeps(db);
    const { stateDb: _omit, ...noDbDeps } = deps;
    const adapter = createDaemonSpawnAdapter(noDbDeps);

    await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: PARENT,
      timeoutMs: 30_000,
      enableTools: ["kanban-*"],
    });

    assert.equal(getSessionToolState(db, deps.spawned[0]).size, 0);
    db.close();
  });
});
