import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../src/lib";
import { createSessionStore } from "../src/sessions/session-store";
import { bootstrapMainSession } from "../src/bootstrap-main-session";
import type { ShoggothConfig } from "@shoggoth/shared";

const TMP = join(import.meta.dirname ?? ".", ".tmp-bootstrap-test");

function stubLogger() {
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const log = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push({ level, msg, fields });
  };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: () => stubLogger().logger,
    logs,
    get logger() {
      return { debug: this.debug, info: this.info, warn: this.warn, error: this.error, child: this.child };
    },
  };
}

function makeConfig(overrides: Partial<ShoggothConfig> = {}): ShoggothConfig {
  return {
    logLevel: "debug",
    stateDbPath: ":memory:",
    socketPath: "/tmp/test.sock",
    workspacesRoot: TMP,
    secretsDirectory: "/tmp",
    inboundMediaRoot: "/tmp",
    operatorDirectory: "/tmp",
    configDirectory: "/tmp",
    hitl: {
      defaultApprovalTimeoutMs: 300000,
      toolRisk: {},
      agentBypassUpTo: {},
      agentToolAutoApprove: {},
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    platforms: {},
    agents: {
      list: {
        main: {
          platforms: {
            discord: {
              routes: [
                {
                  channelId: "1234567890123456789",
                  sessionId: "agent:main:discord:1234567890123456789",
                  guildId: "9876543210987654321",
                },
              ],
            },
          },
        },
      },
    },
    ...overrides,
  } as ShoggothConfig;
}

describe("bootstrapMainSession", () => {
  function setup() {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  }
  function teardown() {
    rmSync(TMP, { recursive: true, force: true });
  }

  it("creates session from agent platform route on fresh DB", () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      bootstrapMainSession({ db, config: makeConfig(), logger: stub.logger as any });

      const store = createSessionStore(db);
      const session = store.getById("agent:main:discord:1234567890123456789");
      assert.ok(session, "session should exist");
      assert.equal(session!.id, "agent:main:discord:1234567890123456789");

      const created = stub.logs.find((l) => l.msg === "bootstrap.main_session.created");
      assert.ok(created, "should log session creation");

      db.close();
    } finally {
      teardown();
    }
  });

  it("skips creation when session already exists", () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      // Bootstrap twice
      bootstrapMainSession({ db, config: makeConfig(), logger: stub.logger as any });
      stub.logs.length = 0;
      bootstrapMainSession({ db, config: makeConfig(), logger: stub.logger as any });

      const exists = stub.logs.find((l) => l.msg === "bootstrap.main_session.exists");
      assert.ok(exists, "should log session exists");
      assert.ok(
        !stub.logs.find((l) => l.msg === "bootstrap.main_session.created"),
        "should not log creation",
      );

      db.close();
    } finally {
      teardown();
    }
  });

  it("warns when DB has sessions but not the expected one", () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());

      // Create a different session first
      const store = createSessionStore(db);
      store.create({
        id: "agent:main:discord:9999999999999999999",
        workspacePath: TMP,
        status: "active",
        runtimeUid: 901,
        runtimeGid: 901,
      });

      const stub = stubLogger();
      bootstrapMainSession({ db, config: makeConfig(), logger: stub.logger as any });

      const warn = stub.logs.find((l) => l.msg === "bootstrap.main_session.missing");
      assert.ok(warn, "should warn about missing session in existing DB");
      assert.equal(warn!.level, "warn");

      const session = store.getById("agent:main:discord:1234567890123456789");
      assert.ok(session, "should still create the session");

      db.close();
    } finally {
      teardown();
    }
  });

  it("derives platform from agent bindings", () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      bootstrapMainSession({ db, config: makeConfig(), logger: stub.logger as any });

      const store = createSessionStore(db);
      // Platform is derived from agent bindings (discord)
      const session = store.getById("agent:main:discord:1234567890123456789");
      assert.ok(session, "should derive platform from agent bindings");

      db.close();
    } finally {
      teardown();
    }
  });

  it("throws when agent has no platform bindings", () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      const cfg = makeConfig({
        agents: { list: { main: {} } },
        runtime: undefined,
      });

      assert.throws(
        () => bootstrapMainSession({ db, config: cfg, logger: stub.logger as any }),
        /No platform bindings configured for agent "main"/,
      );

      db.close();
    } finally {
      teardown();
    }
  });
});
