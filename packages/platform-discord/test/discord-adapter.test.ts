import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import {
  createDiscordAdapter,
  type DiscordInboundEvent,
  type DiscordSessionRoute,
} from "../src/adapter";

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
      authorIsBot: false,
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

  it("resolves dynamic thread/channel id before static routes", () => {
    const adapter = createDiscordAdapter({
      routes,
      resolveThreadSessionId: (id) => (id === "thread-99" ? "sub-sess" : undefined),
    });
    const ev: DiscordInboundEvent = {
      kind: "message_create",
      messageId: "m1",
      channelId: "thread-99",
      guildId: "g1",
      authorId: "user-1",
      authorIsBot: false,
      content: "in thread",
      timestampIso: "2026-03-27T21:05:00.000Z",
    };
    const msg = adapter.inboundToInternal(ev);
    assert.equal(msg.sessionId, "sub-sess");
  });

  it("throws when channel is not routed", () => {
    const adapter = createDiscordAdapter({ routes });
    const ev: DiscordInboundEvent = {
      kind: "message_create",
      messageId: "x",
      channelId: "unknown",
      guildId: "g1",
      authorId: "u",
      authorIsBot: false,
      content: "nope",
      timestampIso: "2026-03-27T21:05:00.000Z",
    };
    assert.throws(() => adapter.inboundToInternal(ev), /no session route/i);
  });
});
