import { describe, it } from "node:test";
import assert from "node:assert";
import { discordMessageCreateToInboundEvent } from "../src/discord/gateway-payload";

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
  });
});
