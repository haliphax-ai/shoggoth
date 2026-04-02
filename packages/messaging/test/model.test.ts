import { describe, it } from "vitest";
import assert from "node:assert";
import {
  createInboundMessage,
  type MessageExtensions,
  type InternalMessage,
} from "../src/model";

describe("Internal message model", () => {
  it("creates inbound message with metadata and extensions", () => {
    const ext: MessageExtensions = {
      attachments: [{ id: "a1", url: "https://cdn.example/f.png", filename: "f.png" }],
      threadId: "thread-9",
      replyToMessageId: "msg-parent",
      reactions: [{ emoji: "👍", count: 2 }],
    };
    const m: InternalMessage = createInboundMessage({
      id: "m1",
      sessionId: "sess-1",
      agentId: "agent-main",
      userId: "u-discord-123",
      createdAt: "2026-03-27T21:00:00.000Z",
      body: "hello",
      extensions: ext,
    });
    assert.equal(m.direction, "inbound");
    assert.equal(m.sessionId, "sess-1");
    assert.equal(m.body, "hello");
    assert.equal(m.extensions.threadId, "thread-9");
    assert.equal(m.extensions.replyToMessageId, "msg-parent");
    assert.equal(m.extensions.attachments?.length, 1);
    assert.equal(m.extensions.reactions?.[0]?.emoji, "👍");
  });
});
