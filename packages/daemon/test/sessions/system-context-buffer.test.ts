import { describe, it, expect, beforeEach } from "vitest";
import {
  pushSystemContext,
  drainSystemContext,
  _resetAllBuffers,
} from "../../src/sessions/system-context-buffer";

describe("system-context-buffer", () => {
  beforeEach(() => {
    _resetAllBuffers();
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
});
