import { describe, it, expect } from "vitest";
import {
  ReactionQueue,
  type QueuedReaction,
} from "../../src/presentation/reaction-queue";

function makeReaction(overrides: Partial<QueuedReaction> = {}): QueuedReaction {
  return {
    messageId: "msg1",
    channelId: "ch1",
    userId: "u1",
    emoji: { id: null, name: "👍" },
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("ReactionQueue", () => {
  it("tracks message IDs for a session", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    expect(q.isInFlight("s1", "m1")).toBe(true);
    expect(q.isInFlight("s1", "m2")).toBe(false);
    expect(q.isInFlight("s2", "m1")).toBe(false);
  });

  it("enqueues and drains reactions", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    const r1 = makeReaction({ messageId: "m1" });
    const r2 = makeReaction({ messageId: "m1", userId: "u2" });
    q.enqueue("s1", r1);
    q.enqueue("s1", r2);

    const drained = q.drain("s1");
    expect(drained).toHaveLength(2);
    expect(drained[0]).toBe(r1);
    expect(drained[1]).toBe(r2);
  });

  it("drain clears tracking and queue", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    q.enqueue("s1", makeReaction());
    q.drain("s1");

    expect(q.isInFlight("s1", "m1")).toBe(false);
    expect(q.drain("s1")).toHaveLength(0);
  });

  it("discard clears tracking and queue", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    q.enqueue("s1", makeReaction());
    q.discard("s1");

    expect(q.isInFlight("s1", "m1")).toBe(false);
    expect(q.drain("s1")).toHaveLength(0);
  });

  it("drain returns empty array when no reactions queued", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    expect(q.drain("s1")).toHaveLength(0);
  });

  it("isolates sessions from each other", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    q.trackMessage("s2", "m2");
    q.enqueue("s1", makeReaction({ messageId: "m1" }));
    q.enqueue("s2", makeReaction({ messageId: "m2" }));

    const d1 = q.drain("s1");
    expect(d1).toHaveLength(1);
    // s2 should still have its reaction
    expect(q.isInFlight("s2", "m2")).toBe(true);
    const d2 = q.drain("s2");
    expect(d2).toHaveLength(1);
  });

  it("_reset clears all state", () => {
    const q = new ReactionQueue();
    q.trackMessage("s1", "m1");
    q.enqueue("s1", makeReaction());
    q._reset();

    expect(q.isInFlight("s1", "m1")).toBe(false);
    expect(q.drain("s1")).toHaveLength(0);
  });
});
