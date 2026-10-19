import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerSession } from "../../src/sessions/builtin-handlers/session-handlers";
import {
  SessionSendNotifyScheduler,
  setSessionSendNotifyScheduler,
  type SessionSendNotifyCompletion,
} from "../../src/sessions/session-send-notify-scheduler";
import { IntegrationOpError } from "../../src/control/integration-ops";
import { resolveSessionSendYieldMs } from "../../src/config/effective-runtime";
import type { ShoggothConfig } from "@shoggoth/shared";

const SESSION_ID = "agent:test:discord:channel:456";
const TARGET_SESSION_ID = "agent:other:discord:channel:789";

type InvokerFn = (sessionId: string, op: string, payload: unknown) => Promise<unknown>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("builtin-session-send yield + notify", () => {
  let completions: SessionSendNotifyCompletion[];
  let scheduler: SessionSendNotifyScheduler;
  let invCalls: Array<{ sessionId: string; op: string; payload: unknown }>;

  function stubCtx(inv: InvokerFn | undefined, config: ShoggothConfig = {}): BuiltinToolContext {
    return {
      sessionId: SESSION_ID,
      config: config as never,
      getAgentIntegrationInvoker: () => inv,
    } as unknown as BuiltinToolContext;
  }

  function reg(): BuiltinToolRegistry {
    const r = new BuiltinToolRegistry();
    registerSession(r);
    return r;
  }

  beforeEach(() => {
    completions = [];
    invCalls = [];
    scheduler = new SessionSendNotifyScheduler(async (c) => {
      completions.push(c);
    });
    setSessionSendNotifyScheduler(scheduler);
  });

  afterEach(() => {
    scheduler.shutdown();
    setSessionSendNotifyScheduler(undefined as unknown as SessionSendNotifyScheduler);
  });

  it("returns the reply inline when it lands within the reply window", async () => {
    const inv: InvokerFn = async (sessionId, op, payload) => {
      invCalls.push({ sessionId, op, payload });
      await sleep(10);
      return { reply: "fast reply", failover: null };
    };
    const result = await reg().execute(
      "session-send",
      { message: "hello", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 5_000 } }),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.reply, "fast reply");
    assert.equal(parsed.failover, null);
    assert.equal(invCalls.length, 1);
    assert.equal(invCalls[0]!.op, "session_send");
    // No handle registered: nothing pending for the session.
    assert.equal(scheduler.countForSession(SESSION_ID), 0);
    assert.equal(completions.length, 0);
  });

  it("yields after the window and registers a notify handle by default", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    const result = await reg().execute(
      "session-send",
      { message: "slow question", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.status, "pending");
    assert.equal(parsed.notify, true);
    assert.equal(typeof parsed.notifyId, "string");
    assert.equal(parsed.targetSessionId, TARGET_SESSION_ID);
    assert.equal(parsed.yieldMs, 50);
    assert.equal(scheduler.countForSession(SESSION_ID), 1);
    const handles = scheduler.listForSession(SESSION_ID);
    assert.equal(handles[0]!.targetSessionId, TARGET_SESSION_ID);
    assert.equal(handles[0]!.message, "slow question");
    // The target's turn settles later → the reply is delivered to the handle.
    d.resolve({ reply: "late reply", failover: null });
    const completion = await waitFor(() => completions[0]);
    assert.equal(completion.reply, "late reply");
    assert.equal(completion.handle.sessionId, SESSION_ID);
    assert.equal(scheduler.countForSession(SESSION_ID), 0);
  });

  it("skips the handle and drops the reply when notify: false", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    const result = await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID, notify: false },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.status, "pending");
    assert.equal(parsed.notify, false);
    assert.equal(parsed.notifyId, undefined);
    assert.equal(scheduler.countForSession(SESSION_ID), 0);
    d.resolve({ reply: "dropped reply" });
    await sleep(50);
    assert.equal(completions.length, 0);
  });

  it("per-call yieldMs overrides the configured window", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    const start = Date.now();
    const result = await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID, yieldMs: 50 },
      stubCtx(inv), // default window is 30 s; the per-call 50 ms must win
    );
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.status, "pending");
    assert.equal(parsed.yieldMs, 50);
    assert.ok(elapsed < 5_000, `expected yield near 50 ms, took ${elapsed}ms`);
    d.resolve({ reply: "ok" });
  });

  it("yieldMs: 0 blocks until the reply arrives (legacy behavior)", async () => {
    const inv: InvokerFn = async () => {
      await sleep(30);
      return { reply: "eventual" };
    };
    const result = await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID, yieldMs: 0 },
      stubCtx(inv),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.reply, "eventual");
    assert.equal(scheduler.countForSession(SESSION_ID), 0);
  });

  it("runtime.sessionSendYieldMs: 0 disables yielding globally", async () => {
    const inv: InvokerFn = async () => {
      await sleep(30);
      return { reply: "blocking" };
    };
    const result = await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 0 } }),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.reply, "blocking");
  });

  it("delivers a failed completion when the send itself errors", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    d.reject(new Error("boom"));
    const completion = await waitFor(() => completions[0]);
    assert.equal(completion.failed, true);
    assert.match(completion.error ?? "", /boom/);
  });

  it("turns the IntegrationOpError result shape into a failed completion", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    // invokeIntegration catches IntegrationOpError and resolves with the
    // { ok: false, code, message } shape instead of rejecting.
    d.reject(new IntegrationOpError("ERR_SESSION_INACTIVE", "session is missing or terminated"));
    const completion = await waitFor(() => completions[0]);
    assert.equal(completion.failed, true);
    assert.equal(completion.error, "session is missing or terminated");
  });

  it("cancelBySession drops pending handles without delivering", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    await reg().execute(
      "session-send",
      { message: "hi", session_id: TARGET_SESSION_ID },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    assert.equal(scheduler.cancelBySession(SESSION_ID), 1);
    d.resolve({ reply: "undelivered" });
    await sleep(50);
    assert.equal(completions.length, 0);
  });

  it("resolves the target from agent_id when no session_id is given", async () => {
    const d = deferred<Record<string, unknown>>();
    const inv: InvokerFn = async () => d.promise;
    const result = await reg().execute(
      "session-send",
      { message: "hi", agent_id: "other" },
      stubCtx(inv, { runtime: { sessionSendYieldMs: 50 } }),
    );
    const parsed = JSON.parse(result.resultJson);
    assert.equal(parsed.targetSessionId, "agent:other");
    d.resolve({ reply: "ok" });
  });
});

describe("resolveSessionSendYieldMs", () => {
  afterEach(() => {
    delete process.env.SHOGGOTH_SESSION_SEND_YIELD_MS;
  });

  it("defaults to 30000", () => {
    assert.equal(resolveSessionSendYieldMs({} as ShoggothConfig), 30_000);
  });

  it("honors runtime.sessionSendYieldMs over the default", () => {
    assert.equal(
      resolveSessionSendYieldMs({ runtime: { sessionSendYieldMs: 5_000 } } as ShoggothConfig),
      5_000,
    );
  });

  it("env SHOGGOTH_SESSION_SEND_YIELD_MS wins over config", () => {
    process.env.SHOGGOTH_SESSION_SEND_YIELD_MS = "1234";
    assert.equal(
      resolveSessionSendYieldMs({ runtime: { sessionSendYieldMs: 5_000 } } as ShoggothConfig),
      1_234,
    );
  });

  it("honors 0 (disabled) from config", () => {
    assert.equal(
      resolveSessionSendYieldMs({ runtime: { sessionSendYieldMs: 0 } } as ShoggothConfig),
      0,
    );
  });
});
