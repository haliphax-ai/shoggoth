import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { reconcilePersistentSubagents } from "../../src/subagent/reconcile-persistent-subagents";
import { disposeSubagentRuntime } from "../../src/subagent/subagent-disposables";
import { createLogger } from "../../src/logging";

describe("reconcilePersistentSubagents", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = join(tmpdir(), `sh-subrecon-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state.db");
    db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
  });

  afterEach(() => {
    closeTestDb(db, dir);
  });

  it("restores active persistent rows and registers thread + bus hooks", () => {
    const sessions = createSessionStore(db);
    const parent = "agent:p:discord:channel:10000000-0000-4000-8000-000000000099";
    const child =
      "agent:p:discord:channel:10000000-0000-4000-8000-000000000099:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
    sessions.create({ id: parent, workspacePath: "/w", status: "active" });
    sessions.create({ id: child, workspacePath: "/w", status: "active" });
    const future = Date.now() + 3_600_000;
    sessions.update(child, {
      parentSessionId: parent,
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-snowflake-1",
      subagentExpiresAtMs: future,
    });

    const registered: string[] = [];
    const subscribed: string[] = [];
    const log = createLogger({ component: "t", minLevel: "error" });
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      logger: log,
      ext: {
        runSessionModelTurn: async () => ({
          latestAssistantText: "",
          failoverMeta: undefined,
        }),
        subscribeSubagentSession: (sid) => {
          subscribed.push(sid);
          return () => {};
        },
        registerPlatformThreadBinding: (tid, sid) => {
          registered.push(`${tid}:${sid}`);
          return () => {};
        },
      },
    });

    assert.equal(r.restored, 1);
    assert.equal(r.expiredKilled, 0);
    assert.deepStrictEqual(registered, ["thread-snowflake-1:" + child]);
    assert.deepStrictEqual(subscribed, [child]);
    disposeSubagentRuntime(child);
  });

  it("kills sessions already past expires_at", () => {
    const sessions = createSessionStore(db);
    const parent = "agent:p:discord:channel:20000000-0000-4000-8000-000000000099";
    const child =
      "agent:p:discord:channel:20000000-0000-4000-8000-000000000099:bbbbbbbb-bbbb-4ccc-dddd-eeeeeeeeeeee";
    sessions.create({ id: parent, workspacePath: "/w", status: "active" });
    sessions.create({ id: child, workspacePath: "/w", status: "active" });
    sessions.update(child, {
      parentSessionId: parent,
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-x",
      subagentExpiresAtMs: Date.now() - 1000,
    });

    const log = createLogger({ component: "t", minLevel: "error" });
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      logger: log,
      ext: {
        runSessionModelTurn: async () => ({
          latestAssistantText: "",
          failoverMeta: undefined,
        }),
        subscribeSubagentSession: () => () => {},
        registerPlatformThreadBinding: () => () => {},
      },
    });

    assert.equal(r.restored, 0);
    assert.equal(r.expiredKilled, 1);
    const row = sessions.getById(child);
    assert.equal(row?.status, "terminated");
  });

  it("restores threadless persistent subagent without registering thread binding", () => {
    const sessions = createSessionStore(db);
    const parent = "agent:p:discord:channel:30000000-0000-4000-8000-000000000099";
    const child =
      "agent:p:discord:channel:30000000-0000-4000-8000-000000000099:cccccccc-bbbb-4ccc-dddd-eeeeeeeeeeee";
    sessions.create({ id: parent, workspacePath: "/w", status: "active" });
    sessions.create({ id: child, workspacePath: "/w", status: "active" });
    const future = Date.now() + 3_600_000;
    sessions.update(child, {
      parentSessionId: parent,
      subagentMode: "persistent",
      subagentExpiresAtMs: future,
      // no subagentPlatformThreadId — threadless A2A-only
    });

    const registered: string[] = [];
    const subscribed: string[] = [];
    const log = createLogger({ component: "t", minLevel: "error" });
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      logger: log,
      ext: {
        runSessionModelTurn: async () => ({
          latestAssistantText: "",
          failoverMeta: undefined,
        }),
        subscribeSubagentSession: (sid) => {
          subscribed.push(sid);
          return () => {};
        },
        registerPlatformThreadBinding: (tid, sid) => {
          registered.push(`${tid}:${sid}`);
          return () => {};
        },
      },
    });

    assert.equal(r.restored, 1);
    assert.equal(r.expiredKilled, 0);
    // No thread binding registered for threadless persistent subagent
    assert.deepStrictEqual(registered, []);
    // Bus subscription still happens
    assert.deepStrictEqual(subscribed, [child]);
    disposeSubagentRuntime(child);
  });
});
