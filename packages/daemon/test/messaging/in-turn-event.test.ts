import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert";
import {
  buildInTurnEventBanner,
  buildSteerBanner,
  deliverInTurnEvent,
} from "../../src/messaging/in-turn-event";
import {
  registerSteerChannel,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

describe("buildInTurnEventBanner", () => {
  it("renders an emoji-lead blockquote with title, detail, and id", () => {
    const b = buildInTurnEventBanner({
      emoji: "↩️",
      title: "Exec notification",
      detail: "npm test",
      id: "n-1",
    });
    assert.equal(b, "> ↩️ Exec notification: *npm test* `n-1`");
  });

  it("omits the detail and id segments when absent", () => {
    const b = buildInTurnEventBanner({ emoji: "🗨️", title: "Agent reply" });
    assert.equal(b, "> 🗨️ Agent reply");
  });

  it("truncates long detail with an ellipsis", () => {
    const b = buildInTurnEventBanner({
      emoji: "↩️",
      title: "Exec notification",
      detail: "x".repeat(200),
    });
    assert.ok(b.includes(`${"x".repeat(60)}…`), b);
    assert.ok(!b.includes("x".repeat(61)), b);
  });

  it("honors maxDetailChars", () => {
    const b = buildInTurnEventBanner({
      emoji: "↩️",
      title: "Exec notification",
      detail: "abcdefghij",
      maxDetailChars: 4,
    });
    assert.equal(b, "> ↩️ Exec notification: *abcd…*");
  });
});

describe("buildSteerBanner", () => {
  it("renders a 🫵 steered blockquote with the prompt verbatim", () => {
    const b = buildSteerBanner("Focus on the failing tests first.");
    assert.equal(b, "> 🫵 **Steered:** Focus on the failing tests first.");
  });

  it("passes the prompt through unmodified (no truncation)", () => {
    const longPrompt = "x".repeat(200);
    const b = buildSteerBanner(longPrompt);
    assert.equal(b, `> 🫵 **Steered:** ${longPrompt}`);
  });

  it("preserves embedded newlines in the prompt", () => {
    const b = buildSteerBanner("line one\nline two");
    assert.equal(b, "> 🫵 **Steered:** line one\nline two");
  });
});

describe("deliverInTurnEvent", () => {
  afterEach(() => {
    _resetAllChannels();
  });

  it("injects into the active steer channel without calling fallback", async () => {
    const { unregister } = registerSteerChannel("sess-1");
    const fallback = vi.fn(async () => {});
    const outcome = await deliverInTurnEvent({
      sessionId: "sess-1",
      content: "hello",
      fallback,
    });
    assert.equal(outcome, "in_turn");
    assert.deepStrictEqual(drainSteers("sess-1"), ["hello"]);
    assert.equal(fallback.mock.calls.length, 0);
    unregister();
  });

  it("calls fallback immediately when no turn is active", async () => {
    const fallback = vi.fn(async () => {});
    const outcome = await deliverInTurnEvent({
      sessionId: "sess-1",
      content: "hello",
      fallback,
    });
    assert.equal(outcome, "fallback");
    assert.equal(fallback.mock.calls.length, 1);
  });

  it("delivers via fallback when the turn ends before the message is drained", async () => {
    const { unregister } = registerSteerChannel("sess-1");
    const fallback = vi.fn(async () => {});
    const outcome = await deliverInTurnEvent({
      sessionId: "sess-1",
      content: "hello",
      fallback,
    });
    assert.equal(outcome, "in_turn");
    assert.equal(fallback.mock.calls.length, 0);
    // The turn ends with the message still queued — delivery must not be lost.
    unregister();
    assert.equal(fallback.mock.calls.length, 1);
  });

  it("does not double-deliver when the message was drained in-turn", async () => {
    const { unregister } = registerSteerChannel("sess-1");
    const fallback = vi.fn(async () => {});
    await deliverInTurnEvent({ sessionId: "sess-1", content: "hello", fallback });
    assert.deepStrictEqual(drainSteers("sess-1"), ["hello"]);
    unregister();
    assert.equal(fallback.mock.calls.length, 0);
  });

  it("delivers via fallback when the channel is replaced before draining", async () => {
    registerSteerChannel("sess-1");
    const fallback = vi.fn(async () => {});
    await deliverInTurnEvent({ sessionId: "sess-1", content: "hello", fallback });
    assert.equal(fallback.mock.calls.length, 0);
    // A new turn registers a fresh channel, dropping the undrained queue.
    const c2 = registerSteerChannel("sess-1");
    assert.equal(fallback.mock.calls.length, 1);
    c2.unregister();
  });

  it("a throwing fallback does not break other dropped callbacks", async () => {
    const { unregister } = registerSteerChannel("sess-1");
    const bad = vi.fn(async () => {
      throw new Error("boom");
    });
    const good = vi.fn(async () => {});
    await deliverInTurnEvent({ sessionId: "sess-1", content: "a", fallback: bad });
    await deliverInTurnEvent({ sessionId: "sess-1", content: "b", fallback: good });
    unregister();
    assert.equal(bad.mock.calls.length, 1);
    assert.equal(good.mock.calls.length, 1);
  });
});
