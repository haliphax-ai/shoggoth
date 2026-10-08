import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import {
  handlePlatformThreadCreate,
  shouldSkipThreadSessionSentinel,
  type ThreadSubagentPlatformDeps,
} from "../../src/subagent/thread-subagent-autocreate";
import { SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS } from "../../src/subagent/subagent-constants";
import { clearAllPersistentSubagentInactivityTimers } from "../../src/subagent/persistent-subagent-timers";
import type { ShoggothConfig } from "@shoggoth/shared";

// Keep session spawns hermetic (no workspace-layout script execution).
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
}));

function makeDb() {
  const tmp = mkdtempSync(join(tmpdir(), "shoggoth-thread-sub-"));
  const db = new Database(join(tmp, "state.db"));
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  return { db, tmp };
}

function baseConfig(): ShoggothConfig {
  return {
    agents: {
      list: { test: { platforms: { discord: {} } } },
    },
    models: {
      providers: [
        {
          id: "prov",
          kind: "openai-compatible",
          baseUrl: "http://x",
          apiKeyEnv: "K",
          models: [{ name: "test-model" }],
        },
      ],
      failoverChain: ["prov/test-model"],
    },
  } as unknown as ShoggothConfig;
}

function makePlatformDeps(
  bindings: Map<string, string>,
  statusBodies: Array<{ sessionId: string; body: string }>,
): ThreadSubagentPlatformDeps {
  return {
    resolveSessionForChannel: (channelId) => bindings.get(channelId.trim()),
    registerPlatformThreadBinding: (threadId, sessionId) => {
      bindings.set(threadId.trim(), sessionId.trim());
      return () => {};
    },
    subscribeSubagentSession: () => () => {},
    sendStatusMessage: async (sessionId, body) => {
      statusBodies.push({ sessionId, body });
    },
  };
}

async function createTopLevelSession(db: Database.Database, tmp: string) {
  const sessions = createSessionStore(db);
  const agentTokens = createSqliteAgentTokenStore(db);
  const sessionManager = createSessionManager({
    db,
    sessions,
    agentTokens,
    workspacesRoot: tmp,
  });
  const { sessionId } = await sessionManager.spawn({
    agentId: "test",
    platform: "discord",
    resourceType: "channel",
    // The URN's channel segment must match the route channel id for route guards;
    // spawn mints the channel segment from the caller, so post-create the URN stays
    // fixed — we only need a valid top-level session row here.
  });
  sessions.update(sessionId, { status: "active" });
  return { sessionId, sessions, sessionManager, agentTokens };
}

describe("handlePlatformThreadCreate", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    ({ db, tmp } = makeDb());
  });

  afterEach(() => {
    // Created thread sessions arm inactivity timers; clear so they don't leak.
    clearAllPersistentSubagentInactivityTimers();
  });

  it("creates a thread-bound subagent session and posts a status message", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([["chan-1", parentSessionId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];

    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.equal(result.created, true);
    const childId = result.sessionId!;
    assert.ok(childId.startsWith("agent:test:discord:"));
    assert.ok(childId !== parentSessionId);
    assert.equal(result.parentSessionId, parentSessionId);

    const child = sessions.getById(childId)!;
    assert.equal(child.parentSessionId, parentSessionId);
    assert.equal(child.subagentMode, "persistent");
    assert.equal(child.subagentPlatformThreadId, "thread-1");
    // Inactivity window from creation time — not a far-future lifetime.
    assert.ok(child.subagentExpiresAtMs !== undefined);
    assert.ok(child.subagentExpiresAtMs > Date.now());
    assert.ok(child.subagentExpiresAtMs <= Date.now() + SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS);

    assert.equal(bindings.get("thread-1"), childId);

    // Status message: URN + current model, emitted immediately on creation.
    assert.equal(statusBodies.length, 1);
    assert.equal(statusBodies[0].sessionId, childId);
    assert.ok(statusBodies[0].body.includes(childId));
    assert.ok(statusBodies[0].body.includes("prov/test-model"));
  });

  it("no-op when disabled", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([["chan-1", parentSessionId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];

    const config = baseConfig();
    (config.agents as { threadSubagents?: boolean }).threadSubagents = false;
    const result = await handlePlatformThreadCreate({
      db,
      config,
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "disabled" });
    assert.equal(statusBodies.length, 0);
  });

  it("no-op when the parent channel is unbound", async () => {
    const { sessions, sessionManager } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>();
    const statusBodies: Array<{ sessionId: string; body: string }> = [];

    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "unknown-chan",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "parent_unbound" });
    assert.equal(statusBodies.length, 0);
  });

  it("no-op when the parent channel binds to a subagent session", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    // A subagent session of the top-level session, bound to "chan-sub".
    const { sessionId: subId } = await sessionManager.spawn({
      parentSessionId,
      parentWorkingDirectory: undefined,
    });
    sessions.update(subId, {
      parentSessionId,
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-sub",
    });

    const bindings = new Map<string, string>([["chan-sub", subId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];
    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-2",
      parentChannelId: "chan-sub",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "parent_not_top_level" });
    assert.equal(statusBodies.length, 0);
  });

  it("is idempotent: a second event for a bound thread creates nothing", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([["chan-1", parentSessionId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];

    const first = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });
    assert.equal(first.created, true);

    const second = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(second, { created: false, reason: "already_bound" });
    assert.equal(statusBodies.length, 1);
  });

  it("is idempotent against a runtime-only binding (no durable row yet)", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([
      ["chan-1", parentSessionId],
      ["thread-1", "agent:test:discord:channel:99999999-9999-4999-8999-999999999999"],
    ]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];

    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "binding_exists" });
    assert.equal(statusBodies.length, 0);
  });
});

describe("shouldSkipThreadSessionSentinel", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;
  let childId: string;
  let sessions: ReturnType<typeof createSessionStore>;

  afterEach(() => {
    // The beforeEach-created thread session arms an inactivity timer.
    clearAllPersistentSubagentInactivityTimers();
  });

  beforeEach(async () => {
    ({ db, tmp } = makeDb());
    const created = await createTopLevelSession(db, tmp);
    sessions = created.sessions;
    const bindings = new Map<string, string>([["chan-1", created.sessionId]]);
    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager: created.sessionManager,
      sessions,
      threadId: "thread-1",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, []),
    });
    childId = result.sessionId!;
  });

  it("skips a first message of exactly '.' for a fresh thread session", () => {
    assert.equal(
      shouldSkipThreadSessionSentinel({ db, sessions, sessionId: childId, body: "." }),
      true,
    );
    assert.equal(
      shouldSkipThreadSessionSentinel({ db, sessions, sessionId: childId, body: "  .  " }),
      true,
    );
  });

  it("does not skip a non-'.' first message", () => {
    assert.equal(
      shouldSkipThreadSessionSentinel({ db, sessions, sessionId: childId, body: "hello" }),
      false,
    );
  });

  it("does not skip '.' once the session has transcript history", () => {
    const row = sessions.getById(childId)!;
    createTranscriptStore(db).append({
      sessionId: childId,
      contextSegmentId: row.contextSegmentId,
      role: "user",
      content: "real prompt",
    });
    assert.equal(
      shouldSkipThreadSessionSentinel({ db, sessions, sessionId: childId, body: "." }),
      false,
    );
  });

  it("does not skip '.' for non-thread or non-subagent sessions", () => {
    // Parent session is top-level and thread-unbound: sentinel must not apply.
    const parentRow = sessions
      .list()
      .find((s) => !s.parentSessionId && s.subagentMode === undefined)!;
    assert.equal(
      shouldSkipThreadSessionSentinel({ db, sessions, sessionId: parentRow.id, body: "." }),
      false,
    );
  });
});
