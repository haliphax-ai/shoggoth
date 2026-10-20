import { describe, it, expect } from "vitest";
import {
  RunawayBreaker,
  buildRunawayCancelNotice,
  buildRunawaySteerBanner,
  buildRunawaySteerMessage,
} from "../../src/sessions/runaway-breaker";

const CALL = (n: number, name = "builtin-read") => ({
  name,
  argsJson: JSON.stringify({ path: `file-${n}.txt` }),
});

describe("RunawayBreaker", () => {
  it("returns ok for varied tool calls", () => {
    const b = new RunawayBreaker();
    for (let i = 0; i < 20; i++) {
      expect(b.record(CALL(i).name, CALL(i).argsJson).verdict).toBe("ok");
    }
  });

  it("steers on the third identical call within the window", () => {
    const b = new RunawayBreaker();
    expect(b.record("t", "{}").verdict).toBe("ok");
    expect(b.record("t", "{}").verdict).toBe("ok");
    const third = b.record("t", "{}");
    expect(third.verdict).toBe("steer");
    if (third.verdict !== "ok") {
      expect(third.trigger.toolName).toBe("t");
      expect(third.trigger.count).toBe(3);
    }
  });

  it("steers on an alternating duplicate pattern (A,B,A,B,A,B)", () => {
    const b = new RunawayBreaker();
    const seq = ["a", "b", "a", "b", "a", "b"];
    const verdicts = seq.map((n) => b.record(n, "{}").verdict);
    // Third "a" is the 5th call; the window resets, so "b" (6th) is ok again.
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok", "steer", "ok"]);
  });

  it("treats identical-prefix long args as duplicates (truncated signature)", () => {
    const b = new RunawayBreaker();
    const base = "x".repeat(250);
    expect(b.record("t", base).verdict).toBe("ok");
    expect(b.record("t", base).verdict).toBe("ok");
    // Differs only past the truncation point — still a duplicate.
    expect(b.record("t", `${base}AAA`).verdict).toBe("steer");
  });

  it("does not count the same signature beyond the window", () => {
    const b = new RunawayBreaker({ windowSize: 15 });
    // Two identical calls, 14 distinct calls, then the same call again:
    // never more than 2 of any signature in the last 15.
    expect(b.record("t", "{}").verdict).toBe("ok");
    expect(b.record("t", "{}").verdict).toBe("ok");
    for (let i = 0; i < 14; i++) b.record(CALL(i).name, CALL(i).argsJson);
    expect(b.record("t", "{}").verdict).toBe("ok");
  });

  it("cancels on the trigger after an earlier steer (second trigger)", () => {
    const b = new RunawayBreaker();
    b.record("t", "{}");
    b.record("t", "{}");
    expect(b.record("t", "{}").verdict).toBe("steer");
    // Window resets after the steer; a fresh identical streak cancels.
    b.record("t", "{}");
    b.record("t", "{}");
    const cancel = b.record("t", "{}");
    expect(cancel.verdict).toBe("cancel");
    if (cancel.verdict !== "ok") {
      expect(cancel.trigger.toolName).toBe("t");
      expect(cancel.trigger.count).toBe(3);
    }
  });

  it("respects a custom duplicate threshold", () => {
    const b = new RunawayBreaker({ maxDuplicates: 0 });
    const first = b.record("t", "{}");
    expect(first.verdict).toBe("steer");
    if (first.verdict !== "ok") expect(first.trigger.count).toBe(1);
  });

  it("exposes steered state", () => {
    const b = new RunawayBreaker();
    expect(b.steered).toBe(false);
    b.record("t", "{}");
    b.record("t", "{}");
    b.record("t", "{}");
    expect(b.steered).toBe(true);
  });
});

describe("runaway breaker copy", () => {
  it("steer message names the tool and tells the model how to recover", () => {
    const msg = buildRunawaySteerMessage({ toolName: "builtin-read", count: 3, signature: "" });
    expect(msg).toContain("builtin-read");
    expect(msg).toContain("3");
  });

  it("steer banner is a blockquote", () => {
    const banner = buildRunawaySteerBanner({ toolName: "t", count: 3, signature: "" });
    expect(banner.startsWith("> ")).toBe(true);
  });

  it("cancel notice names the tool", () => {
    const notice = buildRunawayCancelNotice({ toolName: "t", count: 3, signature: "" });
    expect(notice).toContain("t");
  });
});
