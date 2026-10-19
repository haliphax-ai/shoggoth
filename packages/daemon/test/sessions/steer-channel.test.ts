import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert";
import {
  registerSteerChannel,
  pushSteer,
  drainSteers,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

describe("steer-channel", () => {
  afterEach(() => {
    _resetAllChannels();
  });

  it("pushSteer returns false when no channel is registered", () => {
    assert.equal(pushSteer("sess-1", "hello"), false);
  });

  it("pushSteer returns true and drainSteers yields the message when channel is registered", () => {
    const { unregister } = registerSteerChannel("sess-1");
    assert.equal(pushSteer("sess-1", "steer me"), true);
    const msgs = drainSteers("sess-1");
    assert.deepStrictEqual(msgs, ["steer me"]);
    // drain again should be empty
    assert.deepStrictEqual(drainSteers("sess-1"), []);
    unregister();
  });

  it("accumulates multiple steer messages and drains all at once", () => {
    const { unregister } = registerSteerChannel("sess-1");
    pushSteer("sess-1", "a");
    pushSteer("sess-1", "b");
    pushSteer("sess-1", "c");
    assert.deepStrictEqual(drainSteers("sess-1"), ["a", "b", "c"]);
    unregister();
  });

  it("unregister clears the channel and pushSteer returns false after", () => {
    const { unregister } = registerSteerChannel("sess-1");
    unregister();
    assert.equal(pushSteer("sess-1", "too late"), false);
    assert.deepStrictEqual(drainSteers("sess-1"), []);
  });

  it("channels are independent per session", () => {
    const c1 = registerSteerChannel("sess-1");
    const c2 = registerSteerChannel("sess-2");
    pushSteer("sess-1", "for-1");
    pushSteer("sess-2", "for-2");
    assert.deepStrictEqual(drainSteers("sess-1"), ["for-1"]);
    assert.deepStrictEqual(drainSteers("sess-2"), ["for-2"]);
    c1.unregister();
    c2.unregister();
  });

  it("re-registering a session replaces the old channel", () => {
    const c1 = registerSteerChannel("sess-1");
    pushSteer("sess-1", "old");
    const c2 = registerSteerChannel("sess-1");
    // old messages are gone (new channel)
    assert.deepStrictEqual(drainSteers("sess-1"), []);
    pushSteer("sess-1", "new");
    assert.deepStrictEqual(drainSteers("sess-1"), ["new"]);
    c1.unregister(); // no-op since replaced
    // c2 should still work
    pushSteer("sess-1", "still works");
    assert.deepStrictEqual(drainSteers("sess-1"), ["still works"]);
    c2.unregister();
  });

  // ---- onDropped callbacks (guaranteed in-turn delivery) ----

  it("onDropped is not called for a message that was drained", () => {
    const { unregister } = registerSteerChannel("sess-1");
    const onDropped = vi.fn();
    pushSteer("sess-1", "consumed", { onDropped });
    assert.deepStrictEqual(drainSteers("sess-1"), ["consumed"]);
    unregister();
    assert.equal(onDropped.mock.calls.length, 0);
  });

  it("onDropped fires for undrained messages when the channel unregisters", () => {
    const { unregister } = registerSteerChannel("sess-1");
    const consumed = vi.fn();
    const dropped = vi.fn();
    pushSteer("sess-1", "consumed", { onDropped: consumed });
    drainSteers("sess-1");
    pushSteer("sess-1", "left behind", { onDropped: dropped });
    unregister();
    assert.equal(consumed.mock.calls.length, 0);
    assert.equal(dropped.mock.calls.length, 1);
    // callbacks fire at most once even if unregister is called again
    unregister();
    assert.equal(dropped.mock.calls.length, 1);
  });

  it("onDropped fires for undrained messages when the channel is replaced", () => {
    registerSteerChannel("sess-1");
    const dropped = vi.fn();
    pushSteer("sess-1", "left behind", { onDropped: dropped });
    const c2 = registerSteerChannel("sess-1");
    assert.equal(dropped.mock.calls.length, 1);
    c2.unregister();
  });

  it("one throwing onDropped does not prevent later callbacks", () => {
    const { unregister } = registerSteerChannel("sess-1");
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    pushSteer("sess-1", "a", { onDropped: bad });
    pushSteer("sess-1", "b", { onDropped: good });
    unregister();
    assert.equal(bad.mock.calls.length, 1);
    assert.equal(good.mock.calls.length, 1);
  });
});
