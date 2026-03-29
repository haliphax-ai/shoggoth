import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  createDiscordAdapter,
  type DiscordInboundEvent,
  type DiscordSessionRoute,
} from "../src/discord/adapter";

describe("Discord adapter", () => {
  let routes: DiscordSessionRoute[];

  beforeEach(() => {
    routes = [{ guildId: "g1", channelId: "c1", sessionId: "sess-alpha" }];
  });

  it("maps inbound gateway-style message to InternalMessage and resolves session", () => {
    const adapter = createDiscordAdapter({ routes });
    const ev: DiscordInboundEvent = {
      kind: "message_create",
      messageId: "dm-42",
      channelId: "c1",
      guildId: "g1",
      authorId: "user-7",
      content: "ping",
      timestampIso: "2026-03-27T21:05:00.000Z",
      attachments: [{ id: "att1", url: "https://cdn.discord/x.png", filename: "x.png" }],
      referencedMessageId: "parent-1",
      threadId: "t-9",
    };
    const msg = adapter.inboundToInternal(ev);
    assert.equal(msg.sessionId, "sess-alpha");
    assert.equal(msg.userId, "discord:user-7");
    assert.equal(msg.body, "ping");
    assert.equal(msg.extensions.replyToMessageId, "parent-1");
    assert.equal(msg.extensions.threadId, "t-9");
    assert.equal(msg.extensions.attachments?.[0]?.filename, "x.png");
  });

  it("throws when channel is not routed", () => {
    const adapter = createDiscordAdapter({ routes });
    const ev: DiscordInboundEvent = {
      kind: "message_create",
      messageId: "x",
      channelId: "unknown",
      guildId: "g1",
      authorId: "u",
      content: "nope",
      timestampIso: "2026-03-27T21:05:00.000Z",
    };
    assert.throws(() => adapter.inboundToInternal(ev), /no session route/i);
  });
});
