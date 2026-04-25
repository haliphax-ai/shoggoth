import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "./helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../src/db/open";
import { defaultMigrationsDir, migrate } from "../src/db/migrate";
import { createDaemonSpawnAdapter } from "../src/workflow-adapters.js";
import { upsertCronJob, runCronTick } from "../src/events/cron-scheduler";
import { createDefaultHeartbeatHandlers } from "../src/events/heartbeat-consumer";

import { drainSystemContext } from "../src/sessions/system-context-buffer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-ctx5-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function fakeSessionManager() {
  const spawnCalls: unknown[] = [];
  return {
    spawnCalls,
    spawn: async (input: unknown) => {
      spawnCalls.push(input);
      return {
        sessionId: "agent:main:discord:channel:abc:child-1",
        agentToken: "tok",
        agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
      };
    },
  };
}

function fakeSessionStore() {
  return {
    update: () => {},
    getById: () => undefined,
  };
}

function fakeRunSessionModelTurn() {
  const calls: unknown[] = [];
  const fn = async (input: unknown) => {
    calls.push(input);
    return { latestAssistantText: "done", failoverMeta: null };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Workflow task spawner — context level
// ---------------------------------------------------------------------------

describe("workflow task spawner context level", () => {
  it("defaults to 'minimal' when no contextLevel is provided in deps", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    assert.equal(sm.spawnCalls.length, 1);
    const spawnInput = sm.spawnCalls[0] as Record<string, unknown>;
    assert.equal(spawnInput.contextLevel, "minimal");
  });

  it("respects contextLevel override from deps", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      contextLevel: "light",
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const spawnInput = sm.spawnCalls[0] as Record<string, unknown>;
    assert.equal(spawnInput.contextLevel, "light");
  });

  it("passes 'none' when explicitly configured", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:channel:abc",
      runSessionModelTurn: turn.fn,
      contextLevel: "none",
    });

    await adapter.spawn({
      taskId: 1,
      prompt: "task",
      replyTo: "agent:main:discord:channel:abc",
      timeoutMs: 30_000,
    });

    const spawnInput = sm.spawnCalls[0] as Record<string, unknown>;
    assert.equal(spawnInput.contextLevel, "none");
  });
});

// ---------------------------------------------------------------------------
// Cron job spawner — context level
// ---------------------------------------------------------------------------

describe("cron job context level", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("persists per-job contextLevel and includes it in event payload", () => {
    upsertCronJob(db, {
      id: "job-ctx",
      scheduleExpr: "every:60s",
      payload: { hello: true },
      contextLevel: "minimal",
    });

    // Verify it's stored on the row
    const row = db.prepare("SELECT context_level FROM cron_jobs WHERE id = 'job-ctx'").get() as {
      context_level: string | null;
    };
    assert.equal(row.context_level, "minimal");

    // Fire the cron tick
    db.prepare(
      `UPDATE cron_jobs SET next_run_at = datetime('now', '-1 second') WHERE id = 'job-ctx'`,
    ).run();
    const fired = runCronTick(db);
    assert.equal(fired, 1);

    // Check the event payload includes contextLevel
    const ev = db
      .prepare(
        "SELECT payload_json FROM events WHERE event_type = 'cron.fire' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload_json: string };
    const payload = JSON.parse(ev.payload_json) as {
      cronJobId: string;
      contextLevel?: string;
    };
    assert.equal(payload.cronJobId, "job-ctx");
    assert.equal(payload.contextLevel, "minimal");
  });

  it("omits contextLevel from event payload when not set on job", () => {
    upsertCronJob(db, {
      id: "job-no-ctx",
      scheduleExpr: "every:60s",
      payload: { hello: true },
    });

    // Verify context_level is null
    const row = db.prepare("SELECT context_level FROM cron_jobs WHERE id = 'job-no-ctx'").get() as {
      context_level: string | null;
    };
    assert.equal(row.context_level, null);

    // Fire the cron tick
    db.prepare(
      `UPDATE cron_jobs SET next_run_at = datetime('now', '-1 second') WHERE id = 'job-no-ctx'`,
    ).run();
    runCronTick(db);

    // Check the event payload does NOT include contextLevel
    const ev = db
      .prepare(
        "SELECT payload_json FROM events WHERE event_type = 'cron.fire' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload_json: string };
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    assert.equal(payload.cronJobId, "job-no-ctx");
    assert.equal("contextLevel" in payload, false);
  });

  it("updates contextLevel when upserting an existing job", () => {
    upsertCronJob(db, {
      id: "job-update",
      scheduleExpr: "every:60s",
      contextLevel: "minimal",
    });

    let row = db.prepare("SELECT context_level FROM cron_jobs WHERE id = 'job-update'").get() as {
      context_level: string | null;
    };
    assert.equal(row.context_level, "minimal");

    // Update to a different context level
    upsertCronJob(db, {
      id: "job-update",
      scheduleExpr: "every:60s",
      contextLevel: "full",
    });

    row = db.prepare("SELECT context_level FROM cron_jobs WHERE id = 'job-update'").get() as {
      context_level: string | null;
    };
    assert.equal(row.context_level, "full");
  });
});

// ---------------------------------------------------------------------------
// Heartbeat — context level
// ---------------------------------------------------------------------------

describe("heartbeat context level", () => {
  it("defaults heartbeat.check to 'light' context level", async () => {
    const handlers = createDefaultHeartbeatHandlers();
    const sessionId = "test-session-hb";

    // Simulate a heartbeat.check event
    await handlers["heartbeat.check"]!({
      id: 1,
      scope: `session:${sessionId}`,
      eventType: "heartbeat.check",
      payload: {},
      idempotencyKey: null,
      status: "processing",
      attempts: 1,
      maxAttempts: 8,
      createdAt: new Date().toISOString(),
    });

    const buffered = drainSystemContext(sessionId);
    assert.equal(buffered.length, 1);
    assert.ok(buffered[0]!.includes("[contextLevel=light]"));
  });

  it("respects custom heartbeatContextLevel option", async () => {
    const handlers = createDefaultHeartbeatHandlers({
      heartbeatContextLevel: "minimal",
    });
    const sessionId = "test-session-hb-custom";

    await handlers["heartbeat.check"]!({
      id: 2,
      scope: `session:${sessionId}`,
      eventType: "heartbeat.check",
      payload: {},
      idempotencyKey: null,
      status: "processing",
      attempts: 1,
      maxAttempts: 8,
      createdAt: new Date().toISOString(),
    });

    const buffered = drainSystemContext(sessionId);
    assert.equal(buffered.length, 1);
    assert.ok(buffered[0]!.includes("[contextLevel=minimal]"));
  });

  it("cron.fire handler includes contextLevel from event payload", async () => {
    const handlers = createDefaultHeartbeatHandlers();
    const sessionId = "test-session-cron";

    await handlers["cron.fire"]!({
      id: 3,
      scope: `session:${sessionId}`,
      eventType: "cron.fire",
      payload: { cronJobId: "j1", payload: {}, contextLevel: "minimal" },
      idempotencyKey: null,
      status: "processing",
      attempts: 1,
      maxAttempts: 8,
      createdAt: new Date().toISOString(),
    });

    const buffered = drainSystemContext(sessionId);
    assert.equal(buffered.length, 1);
    assert.ok(buffered[0]!.includes("[contextLevel=minimal]"));
  });

  it("cron.fire handler omits contextLevel tag when not in payload", async () => {
    const handlers = createDefaultHeartbeatHandlers();
    const sessionId = "test-session-cron-no-ctx";

    await handlers["cron.fire"]!({
      id: 4,
      scope: `session:${sessionId}`,
      eventType: "cron.fire",
      payload: { cronJobId: "j2", payload: {} },
      idempotencyKey: null,
      status: "processing",
      attempts: 1,
      maxAttempts: 8,
      createdAt: new Date().toISOString(),
    });

    const buffered = drainSystemContext(sessionId);
    assert.equal(buffered.length, 1);
    assert.ok(!buffered[0]!.includes("[contextLevel="));
  });
});
