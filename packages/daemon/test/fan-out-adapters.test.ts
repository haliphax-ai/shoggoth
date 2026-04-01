import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDaemonSpawnAdapter,
  createDaemonPollAdapter,
  createDaemonKillAdapter,
  createDaemonMessageAdapter,
  type DaemonSpawnAdapterDeps,
  type DaemonPollAdapterDeps,
  type DaemonKillAdapterDeps,
  type DaemonMessageAdapterDeps,
} from "../src/fan-out-adapters.js";

// ---------------------------------------------------------------------------
// Helpers: minimal fakes for daemon internals
// ---------------------------------------------------------------------------

function fakeSessionManager(overrides: Partial<DaemonSpawnAdapterDeps["sessionManager"]> = {}) {
  return {
    spawn: overrides.spawn ?? (() => ({
      sessionId: "agent:main:discord:abc:child-uuid",
      agentToken: "tok",
      agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
    })),
    kill: overrides.kill ?? (() => {}),
    rotateAgentToken: () => ({ sessionId: "", agentToken: "", agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const }),
    attachPromptStack: () => {},
    setLightContext: () => {},
  };
}

function fakeSessionStore(rows: Map<string, { status: string }> = new Map()) {
  return {
    getById: (id: string) => {
      const r = rows.get(id);
      if (!r) return undefined;
      return {
        id,
        status: r.status,
        agentProfileId: undefined,
        workspacePath: "/tmp",
        contextSegmentId: "seg-1",
        modelSelection: undefined,
        lightContext: false,
        promptStack: [] as readonly string[],
        runtimeUid: undefined,
        runtimeGid: undefined,
        parentSessionId: undefined,
        subagentMode: undefined,
        subagentPlatformThreadId: undefined,
        subagentExpiresAtMs: undefined,
        createdAt: "",
        updatedAt: "",
      };
    },
    update: () => {},
    create: () => {},
    delete: () => {},
    list: () => [],
  };
}

function fakeRunSessionModelTurn(result?: { latestAssistantText: string }) {
  const calls: unknown[] = [];
  const fn = async (input: unknown) => {
    calls.push(input);
    return result ?? { latestAssistantText: "done", failoverMeta: null };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// SpawnAdapter
// ---------------------------------------------------------------------------

describe("createDaemonSpawnAdapter", () => {
  it("spawns a child session via sessionManager and returns the session id", async () => {
    const spawnCalls: unknown[] = [];
    const sm = fakeSessionManager({
      spawn: (input: unknown) => {
        spawnCalls.push(input);
        return {
          sessionId: "agent:main:discord:abc:child-1",
          agentToken: "tok",
          agentTokenEnvName: "SHOGGOTH_AGENT_TOKEN" as const,
        };
      },
    });
    const sessions = fakeSessionStore();
    const updateCalls: unknown[] = [];
    sessions.update = (...args: unknown[]) => { updateCalls.push(args); };
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:abc",
      runSessionModelTurn: turn.fn,
    });

    const key = await adapter.spawn({
      taskId: 1,
      prompt: "do the thing",
      replyTo: "agent:main:discord:abc",
      timeoutMs: 30_000,
    });

    assert.equal(key, "agent:main:discord:abc:child-1");
    assert.equal(spawnCalls.length, 1);
    const spawnInput = spawnCalls[0] as Record<string, unknown>;
    assert.equal(spawnInput.parentSessionId, "agent:main:discord:abc");
  });

  it("fires off the model turn asynchronously with the task prompt", async () => {
    const sm = fakeSessionManager();
    const sessions = fakeSessionStore();
    const turn = fakeRunSessionModelTurn();

    const adapter = createDaemonSpawnAdapter({
      sessionManager: sm,
      sessions,
      parentSessionId: "agent:main:discord:abc",
      runSessionModelTurn: turn.fn,
    });

    await adapter.spawn({
      taskId: 2,
      prompt: "analyze data",
      replyTo: "agent:main:discord:abc",
      timeoutMs: 60_000,
    });

    // Give the async fire-and-forget a tick to start
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(turn.calls.length, 1);
    const turnInput = turn.calls[0] as Record<string, unknown>;
    assert.equal(turnInput.sessionId, "agent:main:discord:abc:child-uuid");
    assert.equal(turnInput.userContent, "analyze data");
  });
});

// ---------------------------------------------------------------------------
// PollAdapter
// ---------------------------------------------------------------------------

describe("createDaemonPollAdapter", () => {
  it("returns running for an active session", async () => {
    const rows = new Map([["sess-1", { status: "active" }]]);
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(rows),
      completionMap: new Map(),
    });

    const result = await adapter.poll("sess-1");
    assert.equal(result.status, "running");
  });

  it("returns running for a starting session", async () => {
    const rows = new Map([["sess-1", { status: "starting" }]]);
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(rows),
      completionMap: new Map(),
    });

    const result = await adapter.poll("sess-1");
    assert.equal(result.status, "running");
  });

  it("returns done for a terminated session with output in completion map", async () => {
    const rows = new Map([["sess-1", { status: "terminated" }]]);
    const completionMap = new Map([["sess-1", { ok: true as const, output: "result text" }]]);
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(rows),
      completionMap,
    });

    const result = await adapter.poll("sess-1");
    assert.equal(result.status, "done");
    assert.equal(result.output, "result text");
  });

  it("returns done for a terminated session without completion map entry", async () => {
    const rows = new Map([["sess-1", { status: "terminated" }]]);
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(rows),
      completionMap: new Map(),
    });

    const result = await adapter.poll("sess-1");
    assert.equal(result.status, "done");
  });

  it("returns failed when completion map has an error", async () => {
    const rows = new Map([["sess-1", { status: "terminated" }]]);
    const completionMap = new Map([["sess-1", { ok: false as const, error: "model crashed" }]]);
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(rows),
      completionMap,
    });

    const result = await adapter.poll("sess-1");
    assert.equal(result.status, "failed");
    assert.equal(result.error, "model crashed");
  });

  it("returns failed for an unknown session", async () => {
    const adapter = createDaemonPollAdapter({
      sessions: fakeSessionStore(),
      completionMap: new Map(),
    });

    const result = await adapter.poll("nonexistent");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /not found/i);
  });
});

// ---------------------------------------------------------------------------
// KillAdapter
// ---------------------------------------------------------------------------

describe("createDaemonKillAdapter", () => {
  it("calls sessionManager.kill with the session key", async () => {
    const killCalls: string[] = [];
    const sm = fakeSessionManager({
      kill: (id: string) => { killCalls.push(id); },
    });

    const adapter = createDaemonKillAdapter({ sessionManager: sm });

    await adapter.kill("sess-to-kill");
    assert.deepEqual(killCalls, ["sess-to-kill"]);
  });

  it("calls requestTurnAbort to cancel in-flight turns", async () => {
    const abortCalls: string[] = [];
    const sm = fakeSessionManager();

    const adapter = createDaemonKillAdapter({
      sessionManager: sm,
      requestTurnAbort: (id: string) => { abortCalls.push(id); return true; },
    });

    await adapter.kill("sess-abort");
    assert.deepEqual(abortCalls, ["sess-abort"]);
  });
});

// ---------------------------------------------------------------------------
// MessageAdapter
// ---------------------------------------------------------------------------

describe("createDaemonMessageAdapter", () => {
  it("posts a message via the messaging context and returns messageId", async () => {
    const executeCalls: unknown[] = [];
    const adapter = createDaemonMessageAdapter({
      getMessageContext: () => ({
        execute: async (_sid: string, args: Record<string, unknown>) => {
          executeCalls.push(args);
          return { ok: true, message_id: "msg-123" };
        },
      }),
      resolveChannelId: () => "channel-abc",
      sessionId: "agent:main:discord:abc",
    });

    const result = await adapter.postMessage("hello world");
    assert.equal(result.messageId, "msg-123");
    assert.equal(executeCalls.length, 1);
    const callArgs = executeCalls[0] as Record<string, unknown>;
    assert.equal(callArgs.action, "post");
    assert.equal(callArgs.content, "hello world");
    assert.equal(callArgs.target, "channel-abc");
  });

  it("edits a message and returns true on success", async () => {
    const executeCalls: unknown[] = [];
    const adapter = createDaemonMessageAdapter({
      getMessageContext: () => ({
        execute: async (_sid: string, args: Record<string, unknown>) => {
          executeCalls.push(args);
          return { ok: true };
        },
      }),
      resolveChannelId: () => "channel-abc",
      sessionId: "agent:main:discord:abc",
    });

    const ok = await adapter.editMessage("msg-123", "updated content");
    assert.equal(ok, true);
    assert.equal(executeCalls.length, 1);
    const callArgs = executeCalls[0] as Record<string, unknown>;
    assert.equal(callArgs.action, "edit");
    assert.equal(callArgs.content, "updated content");
    assert.equal(callArgs.message_id, "msg-123");
  });

  it("returns false when edit throws", async () => {
    const adapter = createDaemonMessageAdapter({
      getMessageContext: () => ({
        execute: async () => { throw new Error("edit failed"); },
      }),
      resolveChannelId: () => "channel-abc",
      sessionId: "agent:main:discord:abc",
    });

    const ok = await adapter.editMessage("msg-123", "updated");
    assert.equal(ok, false);
  });

  it("returns false when no message context is available", async () => {
    const adapter = createDaemonMessageAdapter({
      getMessageContext: () => undefined,
      resolveChannelId: () => "channel-abc",
      sessionId: "agent:main:discord:abc",
    });

    const result = await adapter.postMessage("hello");
    // postMessage should still return a messageId (empty/placeholder) or throw
    // Let's verify it handles gracefully
    assert.equal(result.messageId, "");
  });

  it("returns false for edit when no message context is available", async () => {
    const adapter = createDaemonMessageAdapter({
      getMessageContext: () => undefined,
      resolveChannelId: () => "channel-abc",
      sessionId: "agent:main:discord:abc",
    });

    const ok = await adapter.editMessage("msg-123", "updated");
    assert.equal(ok, false);
  });
});
