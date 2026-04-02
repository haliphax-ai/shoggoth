import { describe, it, expect, vi } from "vitest";
import {
  createCoalescingStreamPusher,
} from "../../src/presentation/stream-coordinator";

describe("createCoalescingStreamPusher", () => {
  it("calls setFull immediately when minIntervalMs is 0", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const pusher = createCoalescingStreamPusher(setFull, 0);
    pusher.push("hello");
    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(setFull).toHaveBeenCalledWith("hello");
  });

  it("coalesces rapid pushes within interval", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const pusher = createCoalescingStreamPusher(setFull, 100);

    pusher.push("a");
    // First push fires immediately (elapsed > interval since lastSent=0)
    await new Promise((r) => setTimeout(r, 10));
    expect(setFull).toHaveBeenCalledWith("a");

    // Rapid pushes within interval should coalesce
    pusher.push("b");
    pusher.push("c");
    pusher.push("d");

    // Wait for the coalesced push to fire
    await new Promise((r) => setTimeout(r, 150));
    // Should have sent "d" (the latest) not "b" or "c"
    expect(setFull).toHaveBeenCalledWith("d");
  });

  it("flush sends the latest text", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const pusher = createCoalescingStreamPusher(setFull, 5000);

    pusher.push("first");
    await new Promise((r) => setTimeout(r, 10));
    setFull.mockClear();

    pusher.push("latest");
    await pusher.flush();
    expect(setFull).toHaveBeenCalledWith("latest");
  });

  it("swallows errors from setFull in push path", async () => {
    const setFull = vi.fn().mockRejectedValue(new Error("fail"));
    const pusher = createCoalescingStreamPusher(setFull, 0);

    // Should not throw
    pusher.push("x");
    await new Promise((r) => setTimeout(r, 20));
    expect(setFull).toHaveBeenCalled();
  });
});
