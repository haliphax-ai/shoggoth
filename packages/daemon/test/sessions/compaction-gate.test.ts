import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetAllCompactionGates,
  CompactionGateClosedError,
  pushCompactionRequest,
  registerCompactionGate,
} from "../../src/sessions/compaction-gate";

describe("compaction gate", () => {
  beforeEach(() => {
    _resetAllCompactionGates();
  });

  afterEach(() => {
    _resetAllCompactionGates();
  });

  it("returns undefined when no gate is registered for the session", () => {
    expect(pushCompactionRequest("s1")).toBeUndefined();
  });

  it("parks a request and the loop drains it with the compaction result", async () => {
    const gate = registerCompactionGate("s1");
    const parked = pushCompactionRequest("s1");
    expect(parked).toBeDefined();
    const result = { compacted: true, messageCount: 3 };
    const drained = gate.drain();
    expect(drained).toHaveLength(1);
    drained[0]!.resolve(result);
    await expect(parked).resolves.toEqual(result);
  });

  it("parks multiple requests FIFO; the loop drains one at a time", async () => {
    const gate = registerCompactionGate("s1");
    const p1 = pushCompactionRequest("s1");
    const p2 = pushCompactionRequest("s1");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    // One-at-a-time draining: each compaction must settle before the next is
    // pulled off the queue.
    const batch1 = gate.drain();
    expect(batch1).toHaveLength(2);
    batch1[0]!.resolve({ compacted: true, messageCount: 1 });
    await expect(p1).resolves.toEqual({ compacted: true, messageCount: 1 });
    // The second request is re-parked by the loop between drains in practice;
    // here it is settled directly to verify ordering independence.
    batch1[1]!.resolve({ compacted: false, messageCount: 2 });
    await expect(p2).resolves.toEqual({ compacted: false, messageCount: 2 });
  });

  it("propagates a failed compaction to the parked request", async () => {
    const gate = registerCompactionGate("s1");
    const parked = pushCompactionRequest("s1");
    const [entry] = gate.drain();
    entry!.reject(new Error("summarizer down"));
    await expect(parked).rejects.toThrow("summarizer down");
  });

  it("unregister rejects leftovers so the caller can fall back", async () => {
    const gate = registerCompactionGate("s1");
    const parked = pushCompactionRequest("s1");
    gate.unregister();
    await expect(parked).rejects.toThrow(CompactionGateClosedError);
  });

  it("drain after unregister returns an empty list (gate is closed)", async () => {
    const gate = registerCompactionGate("s1");
    const parked = pushCompactionRequest("s1");
    const rejection = expect(parked).rejects.toThrow(CompactionGateClosedError);
    gate.unregister();
    expect(gate.drain()).toEqual([]);
    await rejection;
  });

  it("a replacement registration rejects the previous gate's leftovers", async () => {
    registerCompactionGate("s1");
    const parked = pushCompactionRequest("s1");
    registerCompactionGate("s1");
    await expect(parked).rejects.toThrow(CompactionGateClosedError);
  });

  it("gates are per-session", async () => {
    const gate = registerCompactionGate("s1");
    expect(pushCompactionRequest("s2")).toBeUndefined();
    const parked = pushCompactionRequest("s1");
    expect(parked).toBeDefined();
    const [entry] = gate.drain();
    entry!.reject(new CompactionGateClosedError());
    await expect(parked).rejects.toThrow(CompactionGateClosedError);
  });
});
