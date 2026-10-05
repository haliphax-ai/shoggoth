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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createCalls = (transport.createMessage as any).mock.calls;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // Final setFullContent with full body (mirrors inbound-session-turn)
    await handle.setFullContent(fullResponse);

    // Should edit original with first chunk
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // Should create overflow message(s) for remaining content
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.createMessage as any).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    await handle.pushUpdate("update message");

    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editCalls = (transport.editMessage as any).mock.calls;
    expect(editCalls[0][2].content).toBe("update message");
    // No overflow messages should be created
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((transport.createMessage as any).mock.calls.length).toBe(0);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    const longText = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.pushUpdate(longText);

    // Should edit original message with first chunk
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editCalls = (transport.editMessage as any).mock.calls;
    expect(editCalls[0][0]).toBe("ch-1");
    expect(editCalls[0][1]).toBe("msg-1");

    // Should create overflow message(s) for remaining content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createCalls = (transport.createMessage as any).mock.calls;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // First, send content that requires overflow
    const longText = "a".repeat(80) + "\n" + "b".repeat(80);
    await handle.pushUpdate(longText);

    // Mock createMessage to return different IDs for overflow messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockResolvedValueOnce({ id: "msg-2" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockResolvedValueOnce({ id: "msg-3" });

    // Reset mocks to track the next call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // Now send content that fits in one message
    await handle.pushUpdate("short message");

    // Should edit original message
    expect(transport.editMessage).toHaveBeenCalledTimes(1);
    // Should delete overflow messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteCalls = (transport.deleteMessage as any).mock.calls;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.createMessage as any).mockClear();

      // First, send content that requires 3 chunks (2 overflow messages)
      const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
      await handle.pushUpdate(longText);

      // Reset mocks to track the next call; every deletion now fails
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.editMessage as any).mockClear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.deleteMessage as any).mockClear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.deleteMessage as any).mockRejectedValue(new Error("boom"));

      const deleteCount = () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (transport.deleteMessage as any).mock.calls.length;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.deleteMessage as any).mockClear();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.createMessage as any)
        .mockResolvedValueOnce({ id: "msg-2" })
        .mockResolvedValueOnce({ id: "msg-3" });

      // First, send content that requires 3 chunks (2 overflow messages)
      const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
      await handle.pushUpdate(longText);

      // Reset mocks; msg-2 deletion always fails, msg-3 succeeds
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.editMessage as any).mockClear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.deleteMessage as any).mockClear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport.deleteMessage as any).mockImplementation((_ch: string, id: string) =>
        id === "msg-2" ? Promise.reject(new Error("boom")) : Promise.resolve(undefined),
      );

      const update = handle.pushUpdate("short message");

      // msg-2: attempts at t=0, t+250ms, t+750ms (exhausted -> give up)
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      // msg-3 is still processed afterwards despite msg-2's failure
      await vi.advanceTimersByTimeAsync(0);
      await update;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deleteCalls = (transport.deleteMessage as any).mock.calls;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // Now send slightly different content that still requires overflow
    const longText2 = "c".repeat(80) + "\n" + "d".repeat(80);
    await handle.pushUpdate(longText2);

    // Should edit original message with first chunk and edit existing overflow messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editCalls = (transport.editMessage as any).mock.calls;
    // First edit is original message, subsequent edits should be for overflow messages
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createCalls = (transport.createMessage as any).mock.calls;
    expect(createCalls.length).toBe(0); // Should not create new messages
  });

  it("pushUpdate deletes stale overflow messages when content shrinks", async () => {
    const transport = createMockTransport();
    const caps = discordCapabilityDescriptor();
    const maxLen = 100;

    // Mock createMessage to return different IDs for overflow messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // Now send content that only requires 2 chunks
    const shorterText = "x".repeat(80) + "\n" + "y".repeat(80);
    await handle.pushUpdate(shorterText);

    // Should delete the third overflow message (msg-4)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteCalls = (transport.deleteMessage as any).mock.calls;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.createMessage as any).mockClear();

    // Now send content that only requires 2 chunks
    const shorterText = "x".repeat(80) + "\n" + "y".repeat(80);
    await handle.setFullContent(shorterText);

    // Should delete the third overflow message (msg-4)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteCalls = (transport.deleteMessage as any).mock.calls;
    expect(deleteCalls.length).toBeGreaterThan(0);
    // Check that msg-4 is deleted (the stale overflow message)
    const msg4Deleted = deleteCalls.some((call) => call[1] === "msg-3");
    expect(msg4Deleted).toBe(true);
  });
});
