import { describe, it } from "vitest";
import assert from "node:assert";
import {
  discordInteractionToCommand,
  type DiscordInteractionEvent,
} from "../src/interaction";

describe("discordInteractionToCommand", () => {
  it("parses an APPLICATION_COMMAND interaction with no options", () => {
    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-1",
      token: "tok-1",
      type: 2, // APPLICATION_COMMAND
      channelId: "ch-1",
      guildId: "g-1",
      userId: "user-1",
      data: { name: "abort" },
    };
    const result = discordInteractionToCommand(ev);
    assert.ok(result);
    assert.strictEqual(result.command.name, "abort");
    assert.deepStrictEqual(result.command.options, {});
    assert.strictEqual(result.interactionId, "int-1");
    assert.strictEqual(result.interactionToken, "tok-1");
  });

  it("parses options from interaction data", () => {
    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-2",
      token: "tok-2",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "user-1",
      data: {
        name: "abort",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:channel:abc" }],
      },
    };
    const result = discordInteractionToCommand(ev);
    assert.ok(result);
    assert.strictEqual(result.command.name, "abort");
    assert.deepStrictEqual(result.command.options, { session_id: "agent:main:discord:channel:abc" });
  });

  it("returns null for non-APPLICATION_COMMAND interactions", () => {
    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-3",
      token: "tok-3",
      type: 1, // PING
      channelId: "ch-1",
      userId: "user-1",
      data: { name: "abort" },
    };
    assert.strictEqual(discordInteractionToCommand(ev), null);
  });

  it("returns null when data has no name", () => {
    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-4",
      token: "tok-4",
      type: 2,
      channelId: "ch-1",
      userId: "user-1",
      data: {} as any,
    };
    assert.strictEqual(discordInteractionToCommand(ev), null);
  });
});
