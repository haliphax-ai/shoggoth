import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert";
import {
  buildSessionSendNotifyResult,
  deliverSessionSendNotifyMessage,
} from "../../src/messaging/session-send-notify-delivery";
import type {
  SessionSendNotifyCompletion,
  SessionSendNotifyHandle,
} from "../../src/sessions/session-send-notify-scheduler";
import {
  registerSteerChannel,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";
import { setSubagentRuntimeExtension } from "../../src/subagent/subagent-extension-ref";

let statusMessages: string[];

function handle(overrides: Partial<SessionSendNotifyHandle> = {}): SessionSendNotifyHandle {
  return {
    id: "ssn1",
    sessionId: "sess-1",
    targetSessionId: "sess-2",
    message: "slow question",
    ...overrides,
  };
}

function completion(
  out: { reply?: string; failover?: unknown; failed?: boolean; error?: string } = {},
): SessionSendNotifyCompletion {
  return { handle: handle(), ...out };
}

describe("buildSessionSendNotifyResult", () => {
  it("always carries identity fields and the message preview", () => {
    const r = buildSessionSendNotifyResult(completion({ reply: "hi" }));
    assert.equal(r.kind, "session.sendReply");
    assert.equal(r.notifyId, "ssn1");
    assert.equal(r.targetSessionId, "sess-2");
    assert.equal(r.message, "slow question");
    assert.equal(r.reply, "hi");
  });

  it("passes failover metadata through when present", () => {
    const r = buildSessionSendNotifyResult(completion({ reply: "hi", failover: { m: 1 } }));
    assert.deepStrictEqual(r.failover, { m: 1 });
  });

  it("shapes failures with the failed flag and error message", () => {
    const r = buildSessionSendNotifyResult(completion({ failed: true, error: "boom" }));
    assert.equal(r.failed, true);
    assert.equal(r.error, "boom");
    assert.equal(r.reply, undefined);
  });

  it("defaults a missing reply to null", () => {
    const r = buildSessionSendNotifyResult(completion());
    assert.equal(r.reply, null);
  });
});

describe("deliverSessionSendNotifyMessage in-turn delivery", () => {
  beforeEach(() => {
    statusMessages = [];
  });

  afterEach(() => {
    _resetAllChannels();
    setSubagentRuntimeExtension(undefined);
  });

  const done: SessionSendNotifyCompletion = completion({ reply: "the reply" });

  function stubStatusExtension(extra: Record<string, unknown> = {}): void {
    setSubagentRuntimeExtension({
      sendStatusMessage: async (_sessionId: string, body: string) => {
        statusMessages.push(body);
      },
      ...extra,
    } as never);
  }

  it("injects into the steer channel when a turn is active — no OOB turn", async () => {
    const runSessionModelTurn = vi.fn();
    stubStatusExtension({ runSessionModelTurn });
    const { unregister } = registerSteerChannel("sess-1");

    await deliverSessionSendNotifyMessage(done);

    const msgs = drainSteers("sess-1");
    assert.equal(msgs.length, 1);
    // Emoji-lead blockquote banner with the payload body underneath
    assert.ok(msgs[0].startsWith("> 📨 Session-send reply: *sess-2* `ssn1`"), msgs[0]);
    assert.ok(msgs[0].includes('"kind": "session.sendReply"'), msgs[0]);
    assert.ok(msgs[0].includes('"reply": "the reply"'), msgs[0]);
    assert.ok(msgs[0].includes('"targetSessionId": "sess-2"'), msgs[0]);
    assert.equal(runSessionModelTurn.mock.calls.length, 0);
    // The in-band delivery also leaves a surface trace.
    assert.equal(statusMessages.length, 1);
    assert.ok(
      statusMessages[0]!.startsWith("> 📨 ✅ Session-send reply delivered in-turn"),
      statusMessages[0],
    );
    assert.ok(statusMessages[0]!.includes("`ssn1`"), statusMessages[0]);
    unregister();
  });

  it("labels failed completions in the banner body", async () => {
    setSubagentRuntimeExtension({ runSessionModelTurn: vi.fn() } as never);
    const { unregister } = registerSteerChannel("sess-1");

    await deliverSessionSendNotifyMessage(completion({ failed: true, error: "boom" }));

    const msgs = drainSteers("sess-1");
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].includes("failed (notify handle `ssn1`)"), msgs[0]);
    assert.ok(msgs[0].includes('"error": "boom"'), msgs[0]);
    unregister();
  });

  it("falls back to an OOB turn when no turn is active", async () => {
    const runSessionModelTurn = vi.fn().mockResolvedValue({ latestAssistantText: "" });
    stubStatusExtension({ runSessionModelTurn });

    await deliverSessionSendNotifyMessage(done);

    assert.equal(runSessionModelTurn.mock.calls.length, 1);
    const call = runSessionModelTurn.mock.calls[0][0];
    assert.equal(call.sessionId, "sess-1");
    assert.equal(call.userMetadata.session_send_notify, true);
    assert.ok(call.userContent.includes('"reply": "the reply"'));
    // The OOB path posts its own processing/terminal banners — no extra post.
    assert.equal(statusMessages.length, 0);
  });
});
