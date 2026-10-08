import assert from "node:assert";
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { defaultConfig } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import type { SessionManager } from "../../src/sessions/session-manager";
import { reconcilePersistentSubagents } from "../../src/subagent/reconcile-persistent-subagents";
import { disposeSubagentRuntime } from "../../src/subagent/subagent-disposables";
import {
  clearAllPersistentSubagentInactivityTimers,
  touchPersistentSubagentInactivityTimer,
} from "../../src/subagent/persistent-subagent-timers";
import { SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS } from "../../src/subagent/subagent-constants";

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

  afterEach(async () => {
    clearAllPersistentSubagentInactivityTimers();
    await closeTestDb(db, dir);
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
    const mockSessionManager = {
      kill: (sid: string) => sessions.update(sid, { status: "terminated" }),
    } as unknown as SessionManager;
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      sessions,
      sessionManager: mockSessionManager,
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

    const mockSessionManager = {
      kill: (sid: string) => sessions.update(sid, { status: "terminated" }),
    } as unknown as SessionManager;
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      sessions,
      sessionManager: mockSessionManager,
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
    const mockSessionManager = {
      kill: (sid: string) => sessions.update(sid, { status: "terminated" }),
    } as unknown as SessionManager;
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      sessions,
      sessionManager: mockSessionManager,
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

  it("defaults a missing expiry to a full inactivity window and persists it", () => {
    const sessions = createSessionStore(db);
    const parent = "agent:p:discord:channel:40000000-0000-4000-8000-000000000099";
    const child =
      "agent:p:discord:channel:40000000-0000-4000-8000-000000000099:dddddddd-bbbb-4ccc-dddd-eeeeeeeeeeee";
    sessions.create({ id: parent, workspacePath: "/w", status: "active" });
    sessions.create({ id: child, workspacePath: "/w", status: "active" });
    sessions.update(child, {
      parentSessionId: parent,
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-z",
      // no subagentExpiresAtMs — must default to a fresh inactivity window
    });

    const before = Date.now();
    const mockSessionManager = {
      kill: (sid: string) => sessions.update(sid, { status: "terminated" }),
    } as unknown as SessionManager;
    const r = reconcilePersistentSubagents({
      db,
      config: defaultConfig(dir),
      sessions,
      sessionManager: mockSessionManager,
      ext: {
        runSessionModelTurn: async () => ({
          latestAssistantText: "",
          failoverMeta: undefined,
        }),
        subscribeSubagentSession: () => () => {},
        registerPlatformThreadBinding: () => () => {},
      },
    });

    assert.equal(r.restored, 1);
    assert.equal(r.expiredKilled, 0);
    const row = sessions.getById(child);
    assert.ok(row?.subagentExpiresAtMs !== undefined);
    assert.ok(row.subagentExpiresAtMs >= before + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS);
    disposeSubagentRuntime(child);
  });

  it("re-arms the persisted window: touch resets the expiry and the timer", () => {
    vi.useFakeTimers();
    try {
      const sessions = createSessionStore(db);
      const parent = "agent:p:discord:channel:50000000-0000-4000-8000-000000000099";
      const child =
        "agent:p:discord:channel:50000000-0000-4000-8000-000000000099:eeeeeeee-bbbb-4ccc-dddd-eeeeeeeeeeee";
      sessions.create({ id: parent, workspacePath: "/w", status: "active" });
      sessions.create({ id: child, workspacePath: "/w", status: "active" });
      const future = Date.now() + 1_000;
      sessions.update(child, {
        parentSessionId: parent,
        subagentMode: "persistent",
        subagentExpiresAtMs: future,
      });

      const killed: string[] = [];
      const mockSessionManager = {
        kill: (sid: string) => {
          killed.push(sid);
          sessions.update(sid, { status: "terminated" });
        },
      } as unknown as SessionManager;
      const r = reconcilePersistentSubagents({
        db,
        config: defaultConfig(dir),
        sessions,
        sessionManager: mockSessionManager,
        ext: {
          runSessionModelTurn: async () => ({
            latestAssistantText: "",
            failoverMeta: undefined,
          }),
          subscribeSubagentSession: () => () => {},
          registerPlatformThreadBinding: () => () => {},
        },
      });
      assert.equal(r.restored, 1);

      // A delivered response resets the clock before the persisted expiry elapses.
      vi.advanceTimersByTime(600);
      touchPersistentSubagentInactivityTimer(child);
      const touched = sessions.getById(child);
      assert.ok(touched?.subagentExpiresAtMs !== undefined);
      assert.ok(touched.subagentExpiresAtMs > future);

      // The original persisted expiry passes without a kill — the timer was re-armed.
      vi.advanceTimersByTime(500);
      assert.equal(sessions.getById(child)?.status, "active");
      assert.deepEqual(killed, []);
      disposeSubagentRuntime(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the session when the re-armed timer elapses without a touch", () => {
    vi.useFakeTimers();
    try {
      const sessions = createSessionStore(db);
      const parent = "agent:p:discord:channel:60000000-0000-4000-8000-000000000099";
      const child =
        "agent:p:discord:channel:60000000-0000-4000-8000-000000000099:ffffffff-bbbb-4ccc-dddd-eeeeeeeeeeee";
      sessions.create({ id: parent, workspacePath: "/w", status: "active" });
      sessions.create({ id: child, workspacePath: "/w", status: "active" });
      sessions.update(child, {
        parentSessionId: parent,
        subagentMode: "persistent",
        subagentExpiresAtMs: Date.now() + 1_000,
      });

      const mockSessionManager = {
        kill: (sid: string) => sessions.update(sid, { status: "terminated" }),
      } as unknown as SessionManager;
      const r = reconcilePersistentSubagents({
        db,
        config: defaultConfig(dir),
        sessions,
        sessionManager: mockSessionManager,
        ext: {
          runSessionModelTurn: async () => ({
            latestAssistantText: "",
            failoverMeta: undefined,
          }),
          subscribeSubagentSession: () => () => {},
          registerPlatformThreadBinding: () => () => {},
        },
      });
      assert.equal(r.restored, 1);

      vi.advanceTimersByTime(1_500);
      assert.equal(sessions.getById(child)?.status, "terminated");
    } finally {
      vi.useRealTimers();
    }
  });
});
