import { describe, it } from "node:test";
import assert from "node:assert";
import { discordInteractionCreateToEvent } from "../src/gateway-payload";

describe("discordInteractionCreateToEvent", () => {
  it("maps INTERACTION_CREATE payload with guild member", () => {
    const ev = discordInteractionCreateToEvent({
      id: "int-1",
      token: "tok-1",
      type: 2,
      channel_id: "ch-1",
      guild_id: "g-1",
      member: { user: { id: "u-1", username: "tester" } },
      data: {
        name: "abort",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:abc" }],
      },
    });
    assert.ok(ev);
    assert.strictEqual(ev.kind, "interaction_create");
    assert.strictEqual(ev.id, "int-1");
    assert.strictEqual(ev.token, "tok-1");
    assert.strictEqual(ev.type, 2);
    assert.strictEqual(ev.channelId, "ch-1");
    assert.strictEqual(ev.guildId, "g-1");
    assert.strictEqual(ev.userId, "u-1");
    assert.strictEqual(ev.data.name, "abort");
    assert.strictEqual(ev.data.options?.[0]?.name, "session_id");
    assert.strictEqual(ev.data.options?.[0]?.value, "agent:main:discord:abc");
  });

  it("maps INTERACTION_CREATE payload with DM user (no member)", () => {
    const ev = discordInteractionCreateToEvent({
      id: "int-2",
      token: "tok-2",
      type: 2,
      channel_id: "ch-2",
      user: { id: "u-2", username: "dm-user" },
      data: { name: "abort" },
    });
    assert.ok(ev);
    assert.strictEqual(ev.userId, "u-2");
    assert.strictEqual(ev.guildId, undefined);
  });

  it("maps INTERACTION_CREATE with no options", () => {
    const ev = discordInteractionCreateToEvent({
      id: "int-3",
      token: "tok-3",
      type: 2,
      channel_id: "ch-3",
      guild_id: "g-3",
      member: { user: { id: "u-3" } },
      data: { name: "abort" },
    });
    assert.ok(ev);
    assert.strictEqual(ev.data.name, "abort");
    assert.strictEqual(ev.data.options, undefined);
  });

  it("returns null for missing required fields", () => {
    assert.strictEqual(discordInteractionCreateToEvent(null), null);
    assert.strictEqual(discordInteractionCreateToEvent({}), null);
    assert.strictEqual(
      discordInteractionCreateToEvent({ id: "x", token: "t", type: 2 }),
      null,
    );
    // Missing user id
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
