import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSubagent } from "../../src/sessions/builtin-handlers/session-handlers";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

const SESSION_ID = "agent:test:discord:channel:123";
const OTHER_SESSION_ID = "agent:test:discord:channel:999";

// The invoking session URN's agent id ("test") is what spawn derives from,
// and the control-plane contract reserves it — so the first derived slug is
// "test-2".
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: SESSION_ID, workspacePath: "/tmp", status: "active" });
  return db;
}

function stubCtx(
  db: Database.Database,
  invoker: (op: string, payload: unknown) => Promise<unknown>,
): BuiltinToolContext {
  return {
    sessionId: SESSION_ID,
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: {},
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: {},
    getAgentIntegrationInvoker: () => async (_sid, op, payload) => invoker(op, payload),
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: { paths: [], embeddings: { enabled: false } },
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

async function spawnAndCapture(
  db: Database.Database,
  args: Record<string, unknown>,
): Promise<{ op: string; payload: Record<string, unknown> }> {
  const reg = new BuiltinToolRegistry();
  registerSubagent(reg);
  let captured: { op: string; payload: Record<string, unknown> } | undefined;
  const result = await reg.execute(
    "subagent",
    args,
    stubCtx(db, async (op, payload) => {
      captured = { op, payload: payload as Record<string, unknown> };
      return { session_id: "child", reply: "ok" };
    }),
  );
  JSON.parse(result.resultJson); // must not throw
  assert.ok(captured, "spawn should reach the control op");
  return captured!;
}

describe("builtin-subagent spawn agent_id derivation", () => {
  it("derives a unique agent id for spawn_one_shot when agent_id is omitted", async () => {
    const db = makeDb();
    const { op, payload } = await spawnAndCapture(db, {
      action: "spawn_one_shot",
      prompt: "do it",
    });
    assert.equal(op, "subagent_spawn");
    assert.equal(payload.agent_id, "test-2");
  });

  it("derives a unique agent id for spawn_persistent when agent_id is omitted", async () => {
    const db = makeDb();
    const { op, payload } = await spawnAndCapture(db, {
      action: "spawn_persistent",
      prompt: "do it",
      thread_id: "555",
    });
    assert.equal(op, "subagent_spawn");
    assert.equal(payload.agent_id, "test-2");
  });

  it("skips ids held by active subagents when deriving", async () => {
    const db = makeDb();
    const sessions = createSessionStore(db);
    sessions.create({
      id: OTHER_SESSION_ID,
      workspacePath: "/tmp",
      status: "active",
      subagentId: "test-2",
    });
    const { payload } = await spawnAndCapture(db, {
      action: "spawn_one_shot",
      prompt: "do it",
    });
    assert.equal(payload.agent_id, "test-3");
  });

  it("does not reserve ids held only by terminated subagents", async () => {
    const db = makeDb();
    const sessions = createSessionStore(db);
    sessions.create({
      id: OTHER_SESSION_ID,
      workspacePath: "/tmp",
      status: "terminated",
      subagentId: "test-2",
    });
    const { payload } = await spawnAndCapture(db, {
      action: "spawn_one_shot",
      prompt: "do it",
    });
    assert.equal(payload.agent_id, "test-2");
  });

  it("forwards an explicit agent_id verbatim", async () => {
    const db = makeDb();
    const { payload } = await spawnAndCapture(db, {
      action: "spawn_one_shot",
      prompt: "do it",
      agent_id: "custom-slug",
    });
    assert.equal(payload.agent_id, "custom-slug");
  });
});
