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

  it("pushUpdate continues deleting overflow messages after a deletion failure", async () => {
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

    // First, send content that requires 3 chunks (2 overflow messages)
    const longText = "a".repeat(80) + "\n" + "b".repeat(80) + "\n" + "c".repeat(80);
    await handle.pushUpdate(longText);

    // Reset mocks to track the next call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.editMessage as any).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.deleteMessage as any).mockClear();
    // First deletion fails, second succeeds
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.deleteMessage as any).mockRejectedValueOnce(new Error("boom"));

    // Now send content that fits in one message
    await expect(handle.pushUpdate("short message")).resolves.toBeUndefined();

    // Both deletions were attempted despite the first failure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteCalls = (transport.deleteMessage as any).mock.calls;
    expect(deleteCalls.length).toBe(2);

    // The failed entry is still tracked, so a later cleanup retries it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (transport.deleteMessage as any).mockClear();
    await handle.pushUpdate("short again");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((transport.deleteMessage as any).mock.calls.length).toBe(1);
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
