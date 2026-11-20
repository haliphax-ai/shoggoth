/**
 * End-of-turn teardown lifecycle for one-shot subagents: failed turns with
 * unanswered steers are held and the steers re-delivered via an OOB turn
 * before teardown; a failed re-delivery still tears down; in-flight wake-up
 * deliveries defer the direct terminate path until the turn ends. Also
 * covers steer-channel drain/settle/take semantics and result dedupe.
 */

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID, formatAgentSessionUrn } from "@shoggoth/shared";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createSessionManager } from "../../src/sessions/session-manager";
import { createSqliteAgentTokenStore } from "../../src/auth/sqlite-agent-tokens";
import { setExecNotifyScheduler } from "../../src/exec/exec-notify-scheduler";
import {
  clearAllOneShotNotifyDrains,
  pendingDrains,
  settleOneShotAfterTurn,
} from "../../src/subagent/one-shot-notify-drain";
import { markOneShotResultDelivered } from "../../src/subagent/one-shot-final-result";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";
import {
  drainSteers,
  pushSteer,
  registerSteerChannel,
  settleSteersAnswered,
  steerDepth,
  takeUnansweredSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";
import { setTurnQueue, tryGetTurnQueue } from "../../src/sessions/session-turn-queue-singleton";
import { TieredTurnQueue } from "../../src/sessions/session-turn-queue";
import { createLogger } from "../../src/logging";
import { createTranscriptStore } from "../../src/sessions/transcript-store";

const subLog = createLogger({ component: "test", minLevel: "error" });

/** The test suite always installs a fresh queue in beforeEach. */
function tryGetTurnQueueOrThrow(): TieredTurnQueue {
  const queue = tryGetTurnQueue();
  assert.ok(queue, "turn queue must be initialized by the test harness");
  return queue;
}

interface RedeliveryTurn {
  readonly outcome: "completed" | "aborted" | "failed" | "canceled";
}

function makeHarness(): {
  db: Database.Database;
  childId: string;
  parentId: string;
} {
  const dir = join(tmpdir(), `shoggoth-ost-lifecycle-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "state.db"));
  db.pragma("foreign_keys = ON");
  migrate(db, defaultMigrationsDir());
  const sessions = createSessionStore(db);
  createSessionManager({
    db,
    sessions,
    agentTokens: createSqliteAgentTokenStore(db),
    workspacesRoot: dir,
  });
  const parentId = formatAgentSessionUrn(
    "par",
    "discord",
    "channel",
    SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  );
  sessions.create({ id: parentId, workspacePath: dir, status: "active" });
  const childId = `agent:par:discord:channel:${SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID}:${randomUUID()}`;
  sessions.create({ id: childId, workspacePath: dir, status: "active" });
  sessions.update(childId, {
    parentSessionId: parentId,
    subagentMode: "one_shot",
    subagentExpiresAtMs: Date.now() + 30 * 60_000,
  });
  return { db, childId, parentId };
}

/** Append one assistant row to the child transcript (the "final reply"). */
function appendChildAssistantText(db: Database.Database, childId: string, text: string): void {
  const sessions = createSessionStore(db);
  const row = sessions.getById(childId);
  assert.ok(row, "child session row must exist");
  createTranscriptStore(db).append({
    sessionId: childId,
    contextSegmentId: row.contextSegmentId,
    role: "assistant",
    content: text,
  });
}

type TurnFactory = (input: { sessionId: string; userContent: string }) => Promise<RedeliveryTurn>;

function installRedeliveryExt(turnFactory: TurnFactory): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  setSubagentRuntimeExtension({
    runSessionModelTurn: (async (input: {
      sessionId: string;
      userContent: string;
      userMetadata?: Record<string, unknown>;
    }) => {
      calls.push({ ...(input as Record<string, unknown>) });
      return turnFactory({ sessionId: input.sessionId, userContent: input.userContent });
    }) as never,
    subscribeSubagentSession: () => () => {},
    registerPlatformThreadBinding: () => () => {},
    announcePersistentSubagentSessionEnded: () => {},
  } as never);
  return { calls };
}

function killRow(db: Database.Database, sid: string): void {
  createSessionStore(db).update(sid, { status: "terminated" });
}

describe("one-shot teardown lifecycle", () => {
  beforeEach(() => {
    clearAllOneShotNotifyDrains();
    _resetAllChannels();
    setTurnQueue(new TieredTurnQueue());
    setExecNotifyScheduler(undefined);
  });
  afterEach(() => {
    clearAllOneShotNotifyDrains();
    setSubagentRuntimeExtension(undefined);
    setExecNotifyScheduler(undefined);
    setTurnQueue(undefined as never);
    _resetAllChannels();
    vi.useRealTimers();
  });

  it("steer-channel: drain marks unanswered; settle clears; take rolls back", () => {
    registerSteerChannel("s1");
    assert.equal(pushSteer("s1", "directive A"), true);
    assert.equal(pushSteer("s1", "directive B"), true);
    assert.equal(steerDepth("s1"), 2, "two queued, none injected");
    const drained = drainSteers("s1");
    assert.deepEqual(drained, ["directive A", "directive B"]);
    assert.equal(steerDepth("s1"), 2, "injected but unanswered still count");
    assert.deepEqual(takeUnansweredSteers("s1"), ["directive A", "directive B"]);
    assert.equal(steerDepth("s1"), 0);
  });

  it("steer-channel: settleSteersAnswered clears the unanswered tracking", () => {
    registerSteerChannel("s2");
    pushSteer("s2", "directive");
    drainSteers("s2");
    assert.equal(steerDepth("s2"), 1);
    settleSteersAnswered("s2");
    assert.equal(steerDepth("s2"), 0, "answered steers no longer hold the session");
    assert.deepEqual(takeUnansweredSteers("s2"), []);
  });

  it("a failed turn with NO unanswered steers tears down normally", () => {
    const { db, childId } = makeHarness();
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "failed",
    });
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "terminated",
      "failed turn without unanswered steers: historical immediate teardown",
    );
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("a failed turn WITH unanswered steers re-delivers them OOB before teardown", async () => {
    const { db, childId } = makeHarness();
    let resolveRedelivery!: (turn: RedeliveryTurn) => void;
    const { calls } = installRedeliveryExt(
      () =>
        new Promise<RedeliveryTurn>((resolve) => {
          resolveRedelivery = resolve;
        }),
    );
    // The turn that is settling had drained a steer into its loop before it
    // failed (tool-loop injection marks the message unanswered).
    registerSteerChannel(childId);
    pushSteer(childId, "Do NOT end this turn until all steps are complete");
    drainSteers(childId);
    assert.equal(steerDepth(childId), 1);

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "failed",
    });
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "held while the steer re-delivery runs",
    );
    assert.equal(pendingDrains.size, 1, "TTL-capped hold registered");
    await vi.waitFor(() => {
      assert.equal(calls.length, 1, "redelivery turn dispatched");
    });
    assert.equal(calls[0]!.sessionId, childId);
    assert.match(String(calls[0]!.userContent), /Do NOT end this turn/);

    // Redelivery turn completes normally → teardown fires.
    resolveRedelivery({ outcome: "completed" });
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(pendingDrains.size, 0);
    db.close();
  });

  it("an aborted steer re-delivery does not wedge the session (one attempt)", async () => {
    const { db, childId } = makeHarness();
    let resolveRedelivery!: (turn: RedeliveryTurn) => void;
    const { calls } = installRedeliveryExt(
      () =>
        new Promise<RedeliveryTurn>((resolve) => {
          resolveRedelivery = resolve;
        }),
    );
    registerSteerChannel(childId);
    pushSteer(childId, "directive");
    drainSteers(childId);

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "failed",
    });
    await vi.waitFor(() => assert.equal(calls.length, 1));

    // The redelivery turn itself is aborted (e.g. the operator killed it):
    // one attempt only — the teardown fires instead of retrying forever.
    resolveRedelivery({ outcome: "aborted" });
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    db.close();
  });

  it("a steer re-delivery onto a terminated target is skipped (no dead-row turn)", async () => {
    const { db, childId } = makeHarness();
    const { calls } = installRedeliveryExt(async () => ({ outcome: "completed" }));
    registerSteerChannel(childId);
    pushSteer(childId, "directive");
    drainSteers(childId);

    // The row dies before the settle runs (operator kill raced the teardown).
    killRow(db, childId);
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "failed",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0, "no turn dispatched onto a terminated session");
    assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    db.close();
  });

  it("the direct terminate path defers while a wake-up delivery is in flight", async () => {
    const { db, childId } = makeHarness();
    let finishTurn!: () => void;
    const turnDone = new Promise<void>((r) => {
      finishTurn = r;
    });
    const queue = tryGetTurnQueueOrThrow();
    const turnPromise = queue.enqueue(childId, "system", "wake-up", async () => {
      await turnDone;
    });

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "wake-up turn mid-flight: the terminate must not abort it",
    );

    finishTurn();
    await turnPromise;
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    db.close();
  });

  it("a steered turn's result is delivered to the parent before teardown (no mark: first delivery was empty)", async () => {
    const { db, childId, parentId } = makeHarness();
    // First turn's result was delivered (the spawn path marked it).
    markOneShotResultDelivered(childId, "");
    // The steered follow-up turn produced a real reply in the transcript.
    appendChildAssistantText(db, childId, "Follow-up status: push landed, PR open.");

    const { calls } = installRedeliveryExt(async () => ({ outcome: "completed" }));
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "completed",
    });
    // The child terminates AFTER the follow-up delivery turn settles.
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(calls.length, 1, "one follow-up delivery turn on the parent");
    assert.equal(calls[0]!.sessionId, parentId);
    const content = String(calls[0]!.userContent);
    assert.match(content, /\[Subagent completed\]/);
    assert.match(content, /Follow-up status: push landed/);
    db.close();
  });

  it("an already-delivered final text is not re-delivered (dedupe)", async () => {
    const { db, childId } = makeHarness();
    appendChildAssistantText(db, childId, "the one and only reply");
    // The spawn path delivered exactly this text.
    markOneShotResultDelivered(childId, "the one and only reply");

    const { calls } = installRedeliveryExt(async () => ({ outcome: "completed" }));
    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "completed",
    });
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(calls.length, 0, "no follow-up when the parent already saw this text");
    db.close();
  });

  it("a live steered turn defers the final-result delivery until the turn ends", async () => {
    const { db, childId, parentId } = makeHarness();
    markOneShotResultDelivered(childId, "");
    appendChildAssistantText(db, childId, "steered reply");

    let finishSteeredTurn!: () => void;
    const steeredDone = new Promise<void>((r) => {
      finishSteeredTurn = r;
    });
    const { calls } = installRedeliveryExt(async () => ({ outcome: "completed" }));
    const queue = tryGetTurnQueueOrThrow();
    const steeredTurn = queue.enqueue(childId, "user", "session_steer", async () => {
      await steeredDone;
    });

    settleOneShotAfterTurn({
      sessionManager: {
        kill: (sid: string) => killRow(db, sid),
      } as never,
      sessions: createSessionStore(db),
      stateDb: db,
      sessionId: childId,
      subLog,
      turnOutcome: "completed",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      createSessionStore(db).getById(childId)?.status,
      "active",
      "held while the steered turn runs",
    );
    assert.equal(calls.length, 0, "no delivery while the steered turn is mid-flight");

    finishSteeredTurn();
    await steeredTurn;
    await vi.waitFor(() => {
      assert.equal(createSessionStore(db).getById(childId)?.status, "terminated");
    });
    assert.equal(calls.length, 1, "follow-up delivered after the steered turn settled");
    assert.equal(calls[0]!.sessionId, parentId);
    db.close();
  });
});
