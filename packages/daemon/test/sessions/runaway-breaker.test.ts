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
    if (third.verdict !== "ok" && third.trigger.kind === "duplicate_tool_call") {
      expect(third.trigger.toolName).toBe("t");
      expect(third.trigger.count).toBe(3);
    } else {
      expect.unreachable("expected a duplicate_tool_call trigger");
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
    if (cancel.verdict !== "ok" && cancel.trigger.kind === "duplicate_tool_call") {
      expect(cancel.trigger.toolName).toBe("t");
      expect(cancel.trigger.count).toBe(3);
    } else {
      expect.unreachable("expected a duplicate_tool_call trigger");
    }
  });

  it("respects a custom duplicate threshold", () => {
    const b = new RunawayBreaker({ maxDuplicates: 0 });
    const first = b.record("t", "{}");
    expect(first.verdict).toBe("steer");
    if (first.verdict !== "ok" && first.trigger.kind === "duplicate_tool_call") {
      expect(first.trigger.count).toBe(1);
    } else {
      expect.unreachable("expected a duplicate_tool_call trigger");
    }
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

describe("RunawayBreaker prose budget", () => {
  it("returns ok while prose stays under the limit", () => {
    const b = new RunawayBreaker({ proseCharLimit: 100 });
    expect(b.recordProse(60).verdict).toBe("ok");
    expect(b.recordProse(39).verdict).toBe("ok");
  });

  it("steers when cumulative prose crosses the limit", () => {
    const b = new RunawayBreaker({ proseCharLimit: 100 });
    b.recordProse(60);
    const trip = b.recordProse(60);
    expect(trip.verdict).toBe("steer");
    if (trip.verdict !== "ok") {
      expect(trip.trigger.kind).toBe("excessive_prose");
      if (trip.trigger.kind === "excessive_prose") {
        expect(trip.trigger.chars).toBe(120);
      }
    }
  });

  it("cancels when the pattern persists after a steer (shared steered state)", () => {
    const b = new RunawayBreaker({ proseCharLimit: 100 });
    // First trigger of ANY kind steers: duplicate tool call here.
    b.record("t", "{}");
    b.record("t", "{}");
    expect(b.record("t", "{}").verdict).toBe("steer");
    // Prose crossing after the steer cancels — one steer per turn, shared
    // across both heuristics.
    const trip = b.recordProse(150);
    expect(trip.verdict).toBe("cancel");
  });

  it("resets the prose counter after a trip", () => {
    const b = new RunawayBreaker({ proseCharLimit: 100 });
    b.recordProse(60);
    expect(b.recordProse(60).verdict).toBe("steer");
    // Counter reset: a full fresh budget is available, not 20k - 120.
    expect(b.recordProse(100).verdict).toBe("ok");
  });

  it("shares the steered state with the duplicate detector in reverse order", () => {
    const b = new RunawayBreaker({ proseCharLimit: 100 });
    expect(b.recordProse(150).verdict).toBe("steer");
    b.record("t", "{}");
    b.record("t", "{}");
    const dupes = b.record("t", "{}");
    expect(dupes.verdict).toBe("cancel");
  });

  it("exposes a custom prose limit", () => {
    const b = new RunawayBreaker({ proseCharLimit: 10 });
    expect(b.recordProse(11).verdict).toBe("steer");
  });

  it("keeps DUPE trigger shape unchanged for the copy builders", () => {
    const b = new RunawayBreaker();
    b.record("t", "{}");
    b.record("t", "{}");
    const trip = b.record("t", "{}");
    expect(trip.verdict).not.toBe("ok");
    if (trip.verdict !== "ok") {
      expect(trip.trigger.kind).toBe("duplicate_tool_call");
      if (trip.trigger.kind === "duplicate_tool_call") {
        expect(trip.trigger.toolName).toBe("t");
        expect(trip.trigger.count).toBe(3);
      }
    }
  });
});

describe("runaway breaker copy", () => {
  const DUPE = {
    kind: "duplicate_tool_call",
    toolName: "builtin-read",
    count: 3,
    signature: "builtin-read|{}",
  } as const;

  it("steer message names the tool and tells the model how to recover", () => {
    const msg = buildRunawaySteerMessage(DUPE);
    expect(msg).toContain("builtin-read");
    expect(msg).toContain("3");
  });

  it("steer banner is a blockquote", () => {
    const banner = buildRunawaySteerBanner(DUPE);
    expect(banner.startsWith("> ")).toBe(true);
  });

  it("cancel notice names the tool", () => {
    const notice = buildRunawayCancelNotice(DUPE);
    expect(notice).toContain("builtin-read");
  });

  it("prose steer message cites the budget and demands tools or brevity", () => {
    const msg = buildRunawaySteerMessage({ kind: "excessive_prose", chars: 21000 });
    expect(msg).toContain("21000");
    expect(msg.toLowerCase()).toContain("prose");
  });

  it("prose steer banner is a blockquote citing the char count", () => {
    const banner = buildRunawaySteerBanner({ kind: "excessive_prose", chars: 21000 });
    expect(banner.startsWith("> ")).toBe(true);
    expect(banner).toContain("21000");
  });

  it("prose cancel notice explains why the turn was canceled", () => {
    const notice = buildRunawayCancelNotice({ kind: "excessive_prose", chars: 42000 });
    expect(notice.toLowerCase()).toContain("prose");
    expect(notice).toContain("42000");
  });
});
