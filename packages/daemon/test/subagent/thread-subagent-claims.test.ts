/**
 * Control-plane thread claims: the spawn flow registers intent to own a thread (or a
 * pending thread creation in a channel) before the thread can exist, and
 * `handlePlatformThreadCreate` skips those events with a distinct reason so the
 * thread-create autocreate never races an in-flight spawn for the same thread.
 * User-created (unclaimed) threads must autocreate exactly as before.
 */

import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import {
  handlePlatformThreadCreate,
  type ThreadSubagentPlatformDeps,
} from "../../src/subagent/thread-subagent-autocreate";
import {
  claimPendingThreadCreationForSpawn,
  claimPlatformThreadIdForSpawn,
  clearThreadSpawnClaims,
  isThreadClaimedByControlPlaneSpawn,
} from "../../src/subagent/thread-subagent-claims";
import { clearAllPersistentSubagentInactivityTimers } from "../../src/subagent/persistent-subagent-timers";
import type { ShoggothConfig } from "@shoggoth/shared";

// Keep session spawns hermetic (no workspace-layout script execution).
vi.mock("../../src/workspaces/agent-workspace-layout", () => ({
  ensureAgentWorkspaceLayout: async () => {},
  resolveAgentTemplateDir: () => "/tmp/templates",
}));

function makeDb() {
  const tmp = mkdtempSync(join(tmpdir(), "shoggoth-thread-claims-"));
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
      providers: {
        prov: {
          kind: "openai-compatible",
          baseUrl: "http://x",
          apiKeyEnv: "K",
          models: [{ name: "test-model" }],
        },
      },
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
  });
  sessions.update(sessionId, { status: "active" });
  return { sessionId, sessions, sessionManager };
}

describe("thread spawn claims", { concurrency: false }, () => {
  afterEach(() => {
    clearThreadSpawnClaims();
    clearAllPersistentSubagentInactivityTimers();
  });

  it("an explicit thread id claim is exclusive until released", () => {
    const release = claimPlatformThreadIdForSpawn("thread-1");
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "thread-1", parentChannelId: "chan-1" }),
      true,
    );
    assert.throws(() => claimPlatformThreadIdForSpawn("thread-1"), /already claimed/);
    release();
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "thread-1", parentChannelId: "chan-1" }),
      false,
    );
    // Released: a later claim succeeds, and release is idempotent.
    const again = claimPlatformThreadIdForSpawn("thread-1");
    again();
    again();
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "thread-1", parentChannelId: "chan-1" }),
      false,
    );
  });

  it("claims are thread- and channel-specific", () => {
    const release = claimPlatformThreadIdForSpawn("thread-a");
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "thread-b", parentChannelId: "chan-2" }),
      false,
    );
    release();
  });

  it("pending creation claims are refcounted per parent channel", () => {
    const releaseOne = claimPendingThreadCreationForSpawn("chan-1");
    const releaseTwo = claimPendingThreadCreationForSpawn("chan-1");
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "not-yet-known", parentChannelId: "chan-1" }),
      true,
    );
    releaseOne();
    // One in-flight creation remains: still claimed.
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "not-yet-known", parentChannelId: "chan-1" }),
      true,
    );
    releaseTwo();
    assert.equal(
      isThreadClaimedByControlPlaneSpawn({ threadId: "not-yet-known", parentChannelId: "chan-1" }),
      false,
    );
  });
});

describe("handlePlatformThreadCreate claim guard", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    ({ db, tmp } = makeDb());
  });

  afterEach(() => {
    clearThreadSpawnClaims();
    clearAllPersistentSubagentInactivityTimers();
  });

  it("skips with control_plane_claimed when the thread is claimed by the spawn flow", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([["chan-1", parentSessionId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];
    const release = claimPlatformThreadIdForSpawn("thread-claimed");

    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-claimed",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "control_plane_claimed" });
    // No session was spawned and no banner was posted.
    assert.equal(sessions.list().length, 1);
    assert.equal(statusBodies.length, 0);
    assert.equal(bindings.get("thread-claimed"), undefined);

    release();
  });

  it("skips with control_plane_claimed for a pending creation in the claimed channel", async () => {
    const {
      sessionId: parentSessionId,
      sessions,
      sessionManager,
    } = await createTopLevelSession(db, tmp);
    const bindings = new Map<string, string>([["chan-1", parentSessionId]]);
    const statusBodies: Array<{ sessionId: string; body: string }> = [];
    // The spawn op registered intent before its thread exists; the gateway event fires
    // with the already-known id and must not autocreate.
    const release = claimPendingThreadCreationForSpawn("chan-1");

    const result = await handlePlatformThreadCreate({
      db,
      config: baseConfig(),
      sessionManager,
      sessions,
      threadId: "thread-new",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.deepEqual(result, { created: false, reason: "control_plane_claimed" });
    assert.equal(sessions.list().length, 1);
    assert.equal(statusBodies.length, 0);
    release();
  });

  it("user-created (unclaimed) threads still autocreate exactly as before", async () => {
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
      threadId: "thread-user",
      parentChannelId: "chan-1",
      platform: makePlatformDeps(bindings, statusBodies),
    });

    assert.equal(result.created, true);
    const child = sessions.getById(result.sessionId!)!;
    assert.equal(child.subagentPlatformThreadId, "thread-user");
    assert.equal(bindings.get("thread-user"), result.sessionId);
    assert.equal(statusBodies.length, 1);
    assert.ok(statusBodies[0].body.includes(result.sessionId!));
  });
});
