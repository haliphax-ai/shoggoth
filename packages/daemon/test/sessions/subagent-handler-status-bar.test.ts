import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSubagent } from "../../src/sessions/builtin-handlers/session-handlers";
import { createSessionStore } from "../../src/sessions/session-store";
import { IntegrationOpError } from "../../src/control/integration-ops";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

const SESSION_ID = "agent:test:discord:channel:123";

type Invoker = (op: string, payload: unknown) => Promise<unknown>;

// The subagent handler resolves the invoking session's spawn depth through the
// session store, so the stub context needs a real db with the session row present.
// The same db backs `onSubagentsChanged` counts, so the invoker factory receives
// it and can create child rows like the real spawn op does before returning.
function stubCtx(
  invokerFactory: (db: Database.Database) => Invoker,
  onSubagentsChanged?: BuiltinToolContext["onSubagentsChanged"],
): { ctx: BuiltinToolContext; db: Database.Database } {
  const db = new Database(":memory:");
  migrate(db, defaultMigrationsDir());
  createSessionStore(db).create({ id: SESSION_ID, workspacePath: "/tmp", status: "active" });
  const invoker = invokerFactory(db);
  return {
    db,
    ctx: {
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
      ...(onSubagentsChanged ? { onSubagentsChanged } : {}),
    },
  };
}

/** Stub invoker factory for a successful spawn: creates the child row like the real op. */
function spawnOkInvoker(mode: "one_shot" | "persistent"): (db: Database.Database) => Invoker {
  return (db) => async (op, payload) => {
    assert.equal(op, "subagent_spawn");
    const parent = (payload as { parent_session_id: string }).parent_session_id;
    const childId = `${parent}:child-${mode}`;
    const sessions = createSessionStore(db);
    sessions.create({ id: childId, workspacePath: "/tmp", status: "active" });
    sessions.update(childId, { parentSessionId: parent, subagentMode: mode });
    return { session_id: childId, mode };
  };
}

describe("builtin-subagent onSubagentsChanged (live status bar counts)", () => {
  it("notifies with fresh counts after a successful one_shot spawn", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    const seen: Array<{ total: number; persistent: number }> = [];
    const { ctx } = stubCtx(spawnOkInvoker("one_shot"), (counts) => seen.push(counts));
    await reg.execute(
      "subagent",
      { action: "spawn_one_shot", prompt: "task", agent_id: "sb-oneshot" },
      ctx,
    );
    assert.equal(seen.length, 1);
    assert.deepStrictEqual(seen[0], { total: 1, persistent: 0 });
  });

  it("notifies with fresh counts after a successful persistent spawn", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    const seen: Array<{ total: number; persistent: number }> = [];
    const { ctx } = stubCtx(spawnOkInvoker("persistent"), (counts) => seen.push(counts));
    await reg.execute(
      "subagent",
      { action: "spawn_persistent", prompt: "task", agent_id: "sb-persist" },
      ctx,
    );
    assert.equal(seen.length, 1);
    assert.deepStrictEqual(seen[0], { total: 1, persistent: 1 });
  });

  it("does not notify when the spawn fails", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    const seen: Array<{ total: number; persistent: number }> = [];
    const { ctx } = stubCtx(
      () => async () => {
        throw new IntegrationOpError("ERR_INVALID_PAYLOAD", "boom");
      },
      (counts) => seen.push(counts),
    );
    const result = await reg.execute(
      "subagent",
      { action: "spawn_one_shot", prompt: "task", agent_id: "sb-fail" },
      ctx,
    );
    assert.equal(JSON.parse(result.resultJson).ok, false);
    assert.equal(seen.length, 0);
  });

  it("does not notify for non-spawn actions", async () => {
    const reg = new BuiltinToolRegistry();
    registerSubagent(reg);
    const seen: Array<{ total: number; persistent: number }> = [];
    const { ctx } = stubCtx(
      () => async () => ({ ok: true }),
      (counts) => seen.push(counts),
    );
    await reg.execute("subagent", { action: "inspect" }, ctx);
    assert.equal(seen.length, 0);
  });
});
