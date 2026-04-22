import { describe, it, vi } from "vitest";


vi.mock("../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execSync: vi.fn((cmd: string, opts?: any) => {
      if (cmd === "id -u agent") return "1000\n";
      if (cmd === "id -g agent") return "1000\n";
      return actual.execSync(cmd, opts);
    }),
  };
});
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../src/lib";
import { createSessionStore } from "../src/sessions/session-store";
import { bootstrapMainSession } from "../src/bootstrap-main-session";
import type { ShoggothConfig } from "@shoggoth/shared";
import { setRootLogger } from "../src/logging";

const TMP = join(import.meta.dirname ?? ".", ".tmp-bootstrap-test");

function stubLogger() {
  const logs: Array<{
    level: string;
    msg: string;
    fields?: Record<string, unknown>;
  }> = [];
  const log =
    (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      logs.push({ level, msg, fields });
    };
  const logger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: () => logger,
  };
  return { logger, logs };
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
      bypassUpTo: "safe",
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
                  sessionId: "agent:main:discord:channel:1234567890123456789",
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

  it("creates session from agent platform route on fresh DB", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: makeConfig() });

      const store = createSessionStore(db);
      const session = store.getById(
        "agent:main:discord:channel:1234567890123456789",
      );
      assert.ok(session, "session should exist");
      assert.equal(
        session!.id,
        "agent:main:discord:channel:1234567890123456789",
      );

      const created = stub.logs.find(
        (l) => l.msg === "bootstrap.agent.session_created",
      );
      assert.ok(created, "should log session creation");

      db.close();
    } finally {
      teardown();
    }
  });

  it("skips creation when session already exists", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      // Bootstrap twice
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: makeConfig() });
      stub.logs.length = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: makeConfig() });

      const exists = stub.logs.find(
        (l) => l.msg === "bootstrap.agent.session_exists",
      );
      assert.ok(exists, "should log session exists");
      assert.ok(
        !stub.logs.find((l) => l.msg === "bootstrap.agent.session_created"),
        "should not log creation",
      );

      db.close();
    } finally {
      teardown();
    }
  });

  it("warns when DB has sessions but not the expected one", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());

      // Create a different session first
      const store = createSessionStore(db);
      store.create({
        id: "agent:main:discord:channel:9999999999999999999",
        workspacePath: TMP,
        status: "active",
        runtimeUid: 901,
        runtimeGid: 901,
      });

      const stub = stubLogger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: makeConfig() });

      // Session should still be created even if others exist
      const session = store.getById(
        "agent:main:discord:channel:1234567890123456789",
      );
      assert.ok(session, "should still create the session");

      db.close();
    } finally {
      teardown();
    }
  });

  it("derives platform from agent bindings", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: makeConfig() });

      const store = createSessionStore(db);
      // Platform is derived from agent bindings (discord)
      const session = store.getById(
        "agent:main:discord:channel:1234567890123456789",
      );
      assert.ok(session, "should derive platform from agent bindings");

      db.close();
    } finally {
      teardown();
    }
  });

  it("warns and skips when agent has no platform bindings", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      const cfg = makeConfig({
        agents: { list: { main: {} } },
        runtime: undefined,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: cfg });

      const warn = stub.logs.find(
        (l) => l.msg === "bootstrap.agent.no_platforms",
      );
      assert.ok(warn, "should warn about missing platform bindings");
      assert.equal(warn!.level, "warn");

      db.close();
    } finally {
      teardown();
    }
  });

  it("bootstraps multiple agents from config", async () => {
    setup();
    try {
      const db = new Database(":memory:");
      migrate(db, defaultMigrationsDir());
      const stub = stubLogger();

      const cfg = makeConfig({
        agents: {
          list: {
            main: {
              platforms: {
                discord: {
                  routes: [
                    {
                      channelId: "1111111111111111111",
                      sessionId:
                        "agent:main:discord:channel:1111111111111111111",
                      guildId: "9876543210987654321",
                    },
                  ],
                },
              },
            },
            developer: {
              platforms: {
                discord: {
                  routes: [
                    {
                      channelId: "2222222222222222222",
                      sessionId:
                        "agent:developer:discord:channel:2222222222222222222",
                      guildId: "9876543210987654321",
                    },
                  ],
                },
              },
            },
          },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRootLogger(stub.logger as any);
      await bootstrapMainSession({ db, config: cfg });

      const store = createSessionStore(db);
      assert.ok(
        store.getById("agent:main:discord:channel:1111111111111111111"),
        "main session should exist",
      );
      assert.ok(
        store.getById("agent:developer:discord:channel:2222222222222222222"),
        "developer session should exist",
      );

      const created = stub.logs.filter(
        (l) => l.msg === "bootstrap.agent.session_created",
      );
      assert.equal(created.length, 2, "should create both sessions");

      db.close();
    } finally {
      teardown();
    }
  });
});
