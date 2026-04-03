import { describe, it } from "vitest";
import assert from "node:assert";
import {
  discordMessageCreateToInboundEvent,
  discordMessageReactionAddToEvent,
  discordInteractionCreateToEvent,
} from "../src/gateway-payload";

describe("discordMessageCreateToInboundEvent", () => {
  it("maps MESSAGE_CREATE payload", () => {
    const ev = discordMessageCreateToInboundEvent(
      {
        id: "mid",
        channel_id: "cid",
        guild_id: "gid",
        author: { id: "aid", bot: false },
        content: "hello",
        timestamp: "2026-03-27T12:00:00.000000+00:00",
        message_reference: { message_id: "parent" },
        attachments: [
          { id: "a1", url: "https://cdn/x.png", filename: "x.png", content_type: "image/png", size: 12 },
        ],
      },
      { allowBotMessages: false },
    );
    assert.ok(ev);
    assert.equal(ev!.channelId, "cid");
    assert.equal(ev!.guildId, "gid");
    assert.equal(ev!.authorId, "aid");
    assert.equal(ev!.authorIsBot, false);
    assert.equal(ev!.content, "hello");
    assert.equal(ev!.referencedMessageId, "parent");
    assert.equal(ev!.attachments?.[0]?.filename, "x.png");
  });

  it("drops bot messages unless allowed", () => {
    const ev = discordMessageCreateToInboundEvent(
      { id: "1", channel_id: "c", author: { id: "b", bot: true }, content: "", timestamp: "2026-01-01T00:00:00.000000+00:00" },
      { allowBotMessages: false },
    );
    assert.equal(ev, null);
    const ev2 = discordMessageCreateToInboundEvent(
      { id: "1", channel_id: "c", author: { id: "b", bot: true }, content: "", timestamp: "2026-01-01T00:00:00.000000+00:00" },
      { allowBotMessages: true },
    );
    assert.ok(ev2);
    assert.equal(ev2!.authorIsBot, true);
  });
});

describe("discordMessageReactionAddToEvent", () => {
  it("maps MESSAGE_REACTION_ADD payload", () => {
    const ev = discordMessageReactionAddToEvent({
      user_id: "u1",
      channel_id: "ch1",
      message_id: "m1",
      guild_id: "g1",
      emoji: { id: null, name: "✅" },
    });
    assert.ok(ev);
    assert.equal(ev!.kind, "message_reaction_add");
    assert.equal(ev!.userId, "u1");
    assert.equal(ev!.channelId, "ch1");
    assert.equal(ev!.messageId, "m1");
    assert.equal(ev!.guildId, "g1");
    assert.equal(ev!.emoji.name, "✅");
    assert.equal(ev!.emoji.id, null);
  });
});

describe("discordInteractionCreateToEvent", () => {
  it("maps INTERACTION_CREATE payload with guild member", () => {
    const ev = discordInteractionCreateToEvent({
      id: "int-1",
      token: "tok-1",
      type: 2,
      channel_id: "ch-1",
      guild_id: "g-1",
      member: { user: { id: "user-1" } },
      data: {
        name: "abort",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:channel:abc" }],
      },
    });
    assert.ok(ev);
    assert.strictEqual(ev!.kind, "interaction_create");
    assert.strictEqual(ev!.id, "int-1");
    assert.strictEqual(ev!.token, "tok-1");
    assert.strictEqual(ev!.type, 2);
    assert.strictEqual(ev!.channelId, "ch-1");
    assert.strictEqual(ev!.guildId, "g-1");
    assert.strictEqual(ev!.userId, "user-1");
    assert.strictEqual(ev!.data.name, "abort");
    assert.strictEqual(ev!.data.options?.[0]?.value, "agent:main:discord:channel:abc");
  });

  it("maps DM interaction (user at top level, no member)", () => {
    const ev = discordInteractionCreateToEvent({
      id: "int-2",
      token: "tok-2",
      type: 2,
      channel_id: "ch-dm",
      user: { id: "dm-user" },
      data: { name: "abort" },
    });
    assert.ok(ev);
    assert.strictEqual(ev!.userId, "dm-user");
    assert.strictEqual(ev!.guildId, undefined);
  });

  it("returns null for missing required fields", () => {
    assert.strictEqual(discordInteractionCreateToEvent(null), null);
    assert.strictEqual(discordInteractionCreateToEvent({}), null);
    assert.strictEqual(
      discordInteractionCreateToEvent({ id: "x", token: "t", type: 2 }),
      null,
    );
    // Missing user
    assert.strictEqual(
      discordInteractionCreateToEvent({
        id: "x",
        token: "t",
        type: 2,
        channel_id: "c",
        data: { name: "abort" },
      }),
      null,
    );
  });
});
