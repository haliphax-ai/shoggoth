import { describe, it, expect, vi } from "vitest";
import { createDiscordStreamingOutbound } from "../src/streaming";
import type { DiscordRestTransport } from "../src/transport";
import { discordCapabilityDescriptor } from "../src/capabilities";

function createMockTransport(): DiscordRestTransport {
  return {
    createMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    createMessageWithFiles: vi.fn().mockResolvedValue({ id: "msg-2" }),
    triggerTypingIndicator: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiscordRestTransport;
}

describe("DiscordStreamingOutbound", () => {
  it("creates overflow messages when content exceeds maxContentLength", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();

    const longText = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.setFullContent(longText);

    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    const createCalls = vi.mocked(transport.createMessage).mock.calls;
    // First call is the "…" placeholder, subsequent calls are overflow
    expect(createCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not create overflow when content fits in maxContentLength", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 2000;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    await handle.setFullContent("short message");

    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    expect(transport.createMessage).toHaveBeenCalledTimes(1);
  });

  it("creates overflow after streaming flush + final setFullContent", async () => {
    const MAX_LEN = 100;
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: MAX_LEN,
    });

    const handle = await streaming.start();

    // Simulate flush: setFullContent with sliced content (fits in one message)
    const fullResponse = "word ".repeat(40); // 200 chars
    const sliced = fullResponse.slice(0, MAX_LEN);
    await handle.setFullContent(sliced);

    // Reset mocks to isolate the final call
    vi.mocked(transport.editMessage).mockClear();
    vi.mocked(transport.createMessage).mockClear();

    // Final setFullContent with full body (mirrors inbound-session-turn)
    await handle.setFullContent(fullResponse);

    // Should edit original with first chunk
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // Should create overflow message(s) for remaining content
    expect(vi.mocked(transport.createMessage).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("pushUpdate edits original message when content fits", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 2000;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    await handle.pushUpdate("update message");

    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    expect(editCalls[0][2].content).toBe("update message");
    // No overflow messages should be created
    expect(vi.mocked(transport.createMessage).mock.calls.length).toBe(0);
  });

  it("pushUpdate creates overflow when content exceeds maxContentLength", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    const longText = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.pushUpdate(longText);

    // Should edit original message with first chunk
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    expect(editCalls[0][0]).toBe("ch-1");
    expect(editCalls[0][1]).toBe("msg-1");

    // Should create overflow message(s) for remaining content
    const createCalls = vi.mocked(transport.createMessage).mock.calls;
    expect(createCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("pushUpdate deletes overflow messages when content shrinks", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    // First, send content that requires overflow
    const longText = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.pushUpdate(longText);

    // Mock createMessage to return different IDs for overflow messages
    vi.mocked(transport.createMessage).mockResolvedValueOnce({ id: "msg-2" });
    vi.mocked(transport.createMessage).mockResolvedValueOnce({ id: "msg-3" });

    // Reset mocks to track the next call
    vi.mocked(transport.editMessage).mockClear();
    vi.mocked(transport.createMessage).mockClear();

    // Now send content that fits in one message
    await handle.pushUpdate("short message");

    // Should edit original message
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // Should delete overflow messages
    const deleteCalls = vi.mocked(transport.deleteMessage).mock.calls;
    expect(deleteCalls.length).toBeGreaterThan(0);
    // Check that the correct channel and message IDs are used for deletion
    expect(deleteCalls[0][0]).toBe("ch-1");
  });

  it("pushUpdate retries a failed overflow deletion a finite number of times then gives up", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      const caps = discordCapabilityDescriptor();
      const maxLen = 100;
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const streaming = createDiscordStreamingOutbound({
        transport,
        capabilities: caps,
        channelId: "ch-1",
        maxContentLength: maxLen,
        logger,
      });

      const handle = await streaming.start();
      // Clear the initial createMessage call
      vi.mocked(transport.createMessage).mockClear();

      // First, send content that requires 3 chunks (2 overflow messages)
      const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
      await handle.pushUpdate(longText);

      // Reset mocks to track the next call; every deletion now fails
      vi.mocked(transport.editMessage).mockClear();
      vi.mocked(transport.deleteMessage).mockClear();
      vi.mocked(transport.deleteMessage).mockRejectedValue(new Error("boom"));

      const deleteCount = () => vi.mocked(transport.deleteMessage).mock.calls.length;

      const update = handle.pushUpdate("short message");

      // Message 1: attempt 1 immediately, then backoff 250ms, then backoff 500ms
      await vi.advanceTimersByTimeAsync(0);
      expect(deleteCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(deleteCount()).toBe(2);
      // Third attempt fails -> give up on message 1 and move on to message 2
      await vi.advanceTimersByTimeAsync(500);
      expect(deleteCount()).toBe(4);
      // Message 2: same finite retry schedule
      await vi.advanceTimersByTimeAsync(250);
      expect(deleteCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(500);
      expect(deleteCount()).toBe(6);

      await vi.advanceTimersByTimeAsync(0);
      await update;

      // Finite retries: exactly 3 attempts per message, then it gives up
      expect(deleteCount()).toBe(6);
      // A warning was logged for each abandoned message
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        "discord.streaming.overflow_delete_failed",
        expect.objectContaining({ attempts: 3 }),
      );

      // The failed entries were dropped: a later update retries nothing
      vi.mocked(transport.deleteMessage).mockClear();
      await handle.pushUpdate("short again");
      expect(deleteCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushUpdate processes remaining overflow messages after one deletion keeps failing", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport();
      const caps = discordCapabilityDescriptor();
      const maxLen = 100;
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const streaming = createDiscordStreamingOutbound({
        transport,
        capabilities: caps,
        channelId: "ch-1",
        maxContentLength: maxLen,
        logger,
      });

      const handle = await streaming.start();
      // Give overflow messages distinct ids: msg-2 and msg-3
      vi.mocked(transport.createMessage)
        .mockResolvedValueOnce({ id: "msg-2" })
        .mockResolvedValueOnce({ id: "msg-3" });

      // First, send content that requires 3 chunks (2 overflow messages)
      const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
      await handle.pushUpdate(longText);

      // Reset mocks; msg-2 deletion always fails, msg-3 succeeds
      vi.mocked(transport.editMessage).mockClear();
      vi.mocked(transport.deleteMessage).mockClear();
      vi.mocked(transport.deleteMessage).mockImplementation((_ch: string, id: string) =>
        id === "msg-2" ? Promise.reject(new Error("boom")) : Promise.resolve(undefined),
      );

      const update = handle.pushUpdate("short message");

      // msg-2: attempts at t=0, t+250ms, t+750ms (exhausted -> give up)
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      // msg-3 is still processed afterwards despite msg-2's failure
      await vi.advanceTimersByTimeAsync(0);
      await update;
      const deleteCalls = vi.mocked(transport.deleteMessage).mock.calls;
      const forMsg2 = deleteCalls.filter((call) => call[1] === "msg-2");
      const forMsg3 = deleteCalls.filter((call) => call[1] === "msg-3");
      expect(forMsg2.length).toBe(3); // finite retries, then give up
      expect(forMsg3.length).toBe(1); // remaining message still processed
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "discord.streaming.overflow_delete_failed",
        expect.objectContaining({ messageId: "msg-2" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushUpdate edits existing overflow messages instead of creating new ones", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    // Mock createMessage to return different IDs for overflow messages
    vi.mocked(transport.createMessage)
      .mockResolvedValueOnce({ id: "msg-1" }) // initial message
      .mockResolvedValueOnce({ id: "msg-2" }) // overflow 1
      .mockResolvedValueOnce({ id: "msg-3" }); // overflow 2

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();

    // First, send content that requires overflow
    const longText1 = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.pushUpdate(longText1);

    // Reset mocks to track the next call
    vi.mocked(transport.editMessage).mockClear();
    vi.mocked(transport.createMessage).mockClear();

    // Now send slightly different content that still requires overflow
    const longText2 = "c".repeat(80) + "\n" + "d".repeat(80);
    await handle.pushUpdate(longText2);

    // Should edit original message with first chunk and edit existing overflow messages
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    // First edit is original message, subsequent edits should be for overflow messages
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    const createCalls = vi.mocked(transport.createMessage).mock.calls;
    expect(createCalls.length).toBe(0); // Should not create new messages
  });

  it("pushUpdate deletes stale overflow messages when content shrinks", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    // Mock createMessage to return different IDs for overflow messages
    vi.mocked(transport.createMessage)
      .mockResolvedValueOnce({ id: "msg-1" }) // initial message
      .mockResolvedValueOnce({ id: "msg-2" }) // overflow 1
      .mockResolvedValueOnce({ id: "msg-3" }); // overflow 2

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();

    // First, send content that requires 3 chunks
    const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
    await handle.pushUpdate(longText);

    // Reset mocks to track the next call
    vi.mocked(transport.editMessage).mockClear();
    vi.mocked(transport.createMessage).mockClear();

    // Now send content that only requires 2 chunks
    const shorterText = "x".repeat(80) + "\n" + "y".repeat(80);
    await handle.pushUpdate(shorterText);

    // Should delete the third overflow message (msg-4)
    const deleteCalls = vi.mocked(transport.deleteMessage).mock.calls;
    expect(deleteCalls.length).toBeGreaterThan(0);
    // Check that msg-4 is deleted (the stale overflow message)
    const msg4Deleted = deleteCalls.some((call) => call[1] === "msg-3");
    expect(msg4Deleted).toBe(true);
  });

  it("setFullContent deletes stale overflow messages", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    // Mock createMessage to return different IDs for overflow messages
    vi.mocked(transport.createMessage)
      .mockResolvedValueOnce({ id: "msg-1" }) // initial message
      .mockResolvedValueOnce({ id: "msg-2" }) // overflow 1
      .mockResolvedValueOnce({ id: "msg-3" }); // overflow 2

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();

    // First, send content that requires 3 chunks
    const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
    await handle.setFullContent(longText);

    // Reset mocks to track the next call
    vi.mocked(transport.editMessage).mockClear();
    vi.mocked(transport.createMessage).mockClear();

    // Now send content that only requires 2 chunks
    const shorterText = "x".repeat(80) + "\n" + "y".repeat(80);
    await handle.setFullContent(shorterText);

    // Should delete the third overflow message (msg-4)
    const deleteCalls = vi.mocked(transport.deleteMessage).mock.calls;
    expect(deleteCalls.length).toBeGreaterThan(0);
    // Check that msg-4 is deleted (the stale overflow message)
    const msg4Deleted = deleteCalls.some((call) => call[1] === "msg-3");
    expect(msg4Deleted).toBe(true);
  });
});

describe("DiscordStreamingOutbound status bar", () => {
  it("setStatusBar stores the bar line and re-edits the in-flight message using the last pushed content", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 2000;

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    await handle.pushUpdate("hello world");
    vi.mocked(transport.editMessage).mockClear();

    await handle.setStatusBar!("> ✅");

    // Re-edits the in-flight message with the last pushed content + the bar
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0][0]).toBe("ch-1");
    expect(editCalls[0][1]).toBe("msg-1");
    expect(editCalls[0][2].content).toBe("hello world\n\n> ✅");

    // A later bar update re-edits using the latest pushed content
    await handle.pushUpdate("second update");
    await handle.setStatusBar!("> 🧠 ｜ 🔢 `2`");
    const laterCalls = vi.mocked(transport.editMessage).mock.calls;
    expect(laterCalls[laterCalls.length - 1][2].content).toBe("second update\n\n> 🧠 ｜ 🔢 `2`");

    // Clearing the bar strips it from the last pushed content
    await handle.setStatusBar!(null);
    const finalCalls = vi.mocked(transport.editMessage).mock.calls;
    expect(finalCalls[finalCalls.length - 1][2].content).toBe("second update");
  });

  it("reserves the bar line in the split budget so the 2000-char limit holds while a bar is active", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 2000;
    const bar = "> ✅ ｜ 🔢 `217` ｜ 🗑️ `1`";

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    // Body whose last chunk would overflow 2000 once the bar is appended
    const body = "a".repeat(1990) + "\n" + "b".repeat(1990);
    await handle.pushUpdate(body);
    await handle.setStatusBar!(bar);

    // Every edit stays within the 2000-char limit
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    for (const call of editCalls) {
      expect(call[2].content.length).toBeLessThanOrEqual(maxLen);
    }
    // The bar made it onto the last delivered chunk as a blank-line-separated
    // blockquote. With the bar reserved in the split budget the reduced budget
    // produces an extra overflow message, so the last delivered chunk may be a
    // create rather than an edit.
    const editCallsAll = vi.mocked(transport.editMessage).mock.calls;
    const createCallsAll = vi.mocked(transport.createMessage).mock.calls;
    const delivered = [
      ...editCallsAll.map((call) => call[2].content),
      ...createCallsAll.map((call) => call[1].content),
    ];
    for (const content of delivered) {
      expect(content.length).toBeLessThanOrEqual(maxLen);
    }
    const lastDelivered = delivered[delivered.length - 1];
    expect(lastDelivered.endsWith("\n\n" + bar)).toBe(true);
    expect(lastDelivered.length).toBeLessThanOrEqual(maxLen);
  });

  it("lands the bar on the last chunk only as a blank-line-separated blockquote", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;
    const bar = "> ✅";

    const streaming = createDiscordStreamingOutbound({
      transport,
      capabilities: caps,
      channelId: "ch-1",
      maxContentLength: maxLen,
    });

    const handle = await streaming.start();
    // Clear the initial createMessage call
    vi.mocked(transport.createMessage).mockClear();

    // Three-chunk body: the bar must appear only on the final chunk
    const body = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
    await handle.pushUpdate(body);
    await handle.setStatusBar!(bar);
    const editCalls = vi.mocked(transport.editMessage).mock.calls;
    const barEdits = editCalls.filter((call) => call[2].content.includes(bar));
    expect(barEdits).toHaveLength(1);
    // The single bar edit is the last chunk, blank-line-separated blockquote
    expect(editCalls[editCalls.length - 1][2].content.endsWith("\n\n" + bar)).toBe(true);
  });
});
