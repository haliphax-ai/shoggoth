import { describe, it, expect, vi } from "vitest";
import { notifyOnTurnAbort } from "../../src/sessions/session-turn-abort";

describe("notifyOnTurnAbort", () => {
  it("fires immediately when the signal is already aborted (abort raced the wiring)", () => {
    const ac = new AbortController();
    ac.abort();
    const onAborted = vi.fn();
    notifyOnTurnAbort(ac.signal, onAborted);
    // A bare addEventListener would NEVER fire here — the display pipeline
    // would keep editing a dead session's message forever.
    expect(onAborted).toHaveBeenCalledTimes(1);
  });

  it("fires once on abort for a live signal", () => {
    const ac = new AbortController();
    const onAborted = vi.fn();
    notifyOnTurnAbort(ac.signal, onAborted);
    expect(onAborted).not.toHaveBeenCalled();
    ac.abort();
    ac.abort();
    expect(onAborted).toHaveBeenCalledTimes(1);
  });
});
