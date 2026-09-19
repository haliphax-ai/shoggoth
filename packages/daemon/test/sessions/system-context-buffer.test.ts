import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pushSystemContext,
  drainSystemContext,
  _resetAllBuffers,
} from "../../src/sessions/system-context-buffer";

describe("system-context-buffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetAllBuffers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drain returns empty array for unknown session", () => {
    expect(drainSystemContext("unknown")).toEqual([]);
  });

  it("push then drain returns entries in order", () => {
    pushSystemContext("s1", "first");
    pushSystemContext("s1", "second");
    expect(drainSystemContext("s1")).toEqual(["first", "second"]);
  });

  it("drain clears the buffer", () => {
    pushSystemContext("s1", "entry");
    drainSystemContext("s1");
    expect(drainSystemContext("s1")).toEqual([]);
  });

  it("sessions are independent", () => {
    pushSystemContext("s1", "a");
    pushSystemContext("s2", "b");
    expect(drainSystemContext("s1")).toEqual(["a"]);
    expect(drainSystemContext("s2")).toEqual(["b"]);
  });

  it("multiple entries stack", () => {
    pushSystemContext("s1", "Fresh session. No prior conversation history.");
    pushSystemContext("s1", "Scheduled cron job invocation.");
    const entries = drainSystemContext("s1");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe("Fresh session. No prior conversation history.");
    expect(entries[1]).toBe("Scheduled cron job invocation.");
  });

  it("stale entries are cleaned up by the sweep timer", () => {
    // Push an entry that will become stale
    pushSystemContext("stale-session", "context A");

    // Advance past the TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    // Push a fresh entry (at the new fake time)
    pushSystemContext("fresh-session", "context B");

    // Advance enough for the sweep to fire again
    vi.advanceTimersByTime(2 * 60 * 1000);

    // The stale entry should have been removed, the fresh one should remain
    expect(drainSystemContext("stale-session")).toEqual([]);
    expect(drainSystemContext("fresh-session")).toEqual(["context B"]);
  });

  it("push resets the TTL for a session", () => {
    pushSystemContext("s1", "first");

    // Advance most of the way to TTL
    vi.advanceTimersByTime(4 * 60 * 1000);

    // Push again — this resets the timestamp
    pushSystemContext("s1", "second");

    // Advance another 4 minutes (total 8 min, but only 4 min since last push)
    vi.advanceTimersByTime(4 * 60 * 1000);

    // Entry should still exist because the last push was only 4 min ago
    expect(drainSystemContext("s1")).toEqual(["first", "second"]);
  });
});
