import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import {
  registerSteerChannel,
  pushSteer,
  _resetAllChannels,
} from "../../src/sessions/steer-channel";

/**
 * Tests the split-path logic used by session_steer in integration-ops:
 * - If an active tool loop exists (steer channel registered), pushSteer returns true → inject path
 * - If no active loop, pushSteer returns false → fall through to runSessionModelTurn
 */
describe("session_steer split path via steer channel", () => {
  afterEach(() => {
    _resetAllChannels();
  });

  it("pushSteer returns true when tool loop is active (inject path)", () => {
    const handle = registerSteerChannel("sess-1");
    const injected = pushSteer("sess-1", "steer prompt");
    assert.equal(injected, true);
    handle.unregister();
  });

  it("pushSteer returns false when no tool loop is active (fallback path)", () => {
    const injected = pushSteer("sess-1", "steer prompt");
    assert.equal(injected, false);
  });

  it("pushSteer returns false after tool loop exits", () => {
    const handle = registerSteerChannel("sess-1");
    handle.unregister();
    const injected = pushSteer("sess-1", "steer prompt");
    assert.equal(injected, false);
  });
});
