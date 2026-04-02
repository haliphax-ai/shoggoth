import { describe, it, expect, vi } from "vitest";
import { createCoalescingStreamPusher } from "../../src/presentation/index.js";

describe("createCoalescingStreamPusher", () => {
  it("calls setFull immediately on first push when minInterval is 0", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const { push, flush } = createCoalescingStreamPusher(setFull, 0);
    push("hello");
    await flush();
    expect(setFull).toHaveBeenCalledWith("hello");
  });

  it("coalesces rapid pushes", async () => {
    const calls: string[] = [];
    const setFull = vi.fn().mockImplementation(async (text: string) => {
      calls.push(text);
    });
    const { push, flush } = createCoalescingStreamPusher(setFull, 50);

    push("a");
    push("ab");
    push("abc");

    await flush();
    // flush always sends the latest value
    expect(calls[calls.length - 1]).toBe("abc");
  });

  it("flush sends the latest text even if no push happened", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const { flush } = createCoalescingStreamPusher(setFull, 100);
    await flush();
    expect(setFull).toHaveBeenCalledWith("");
  });

  it("sends immediately when enough time has passed", async () => {
    const setFull = vi.fn().mockResolvedValue(undefined);
    const { push, flush } = createCoalescingStreamPusher(setFull, 10);

    push("first");
    // Wait longer than minInterval
    await new Promise((r) => setTimeout(r, 30));
    push("second");
    await flush();

    expect(setFull).toHaveBeenCalledWith("first");
    expect(setFull).toHaveBeenCalledWith("second");
  });
});
