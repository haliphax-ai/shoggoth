import { describe, it } from "node:test";
import assert from "node:assert";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { executeDiscordMessageToolAction } from "../src/discord/message-tool";
import type { DiscordRestTransport } from "../src/discord/transport";

function emptyGetStubs(): Pick<
  DiscordRestTransport,
  "getMessage" | "getChannelMessages"
> {
  return {
    async getMessage(channelId, messageId) {
      return {
        id: messageId,
        channel_id: channelId,
        content: "body",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "tester", bot: false },
        attachments: [],
      };
    },
    async getChannelMessages() {
      return [];
    },
  };
}

describe("executeDiscordMessageToolAction", () => {
  const caps = discordCapabilityDescriptor();

  it("post: JSON createMessage when no attachments", async () => {
    const calls: string[] = [];
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage(ch, body) {
        calls.push(`create:${ch}:${(body as { content: string }).content}`);
        return { id: "m1" };
      },
      async createMessageWithFiles() {
        throw new Error("unexpected multipart");
      },
      async editMessage() {},
      async deleteMessage() {},
      ...emptyGetStubs(),
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      {
        capabilities: caps,
        transport,
        sessionToChannel: () => "chan-a",
      },
      "agent:x:discord:00000000-0000-4000-8000-000000000001",
      { action: "post", content: "hello" },
    );
    assert.deepEqual(r, { ok: true, message_id: "m1", channel_id: "chan-a" });
    assert.equal(calls[0], "create:chan-a:hello");
  });

  it("post: multipart when attachments present", async () => {
    let multipart = false;
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        throw new Error("unexpected json");
      },
      async createMessageWithFiles(ch, body) {
        multipart = true;
        assert.equal(ch, "chan-b");
        assert.equal((body as { content: string }).content, "f");
        return { id: "m2" };
      },
      async editMessage() {},
      async deleteMessage() {},
      ...emptyGetStubs(),
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-b" },
      "sess",
      {
        action: "post",
        content: "f",
        attachments: [{ filename: "x.bin", content_base64: "YWI=" }],
      },
    );
    assert.deepEqual(r, { ok: true, message_id: "m2", channel_id: "chan-b" });
    assert.equal(multipart, true);
  });

  it("rejects attachments when capability off", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      ...emptyGetStubs(),
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const noAtt = {
      ...caps,
      extensions: { ...caps.extensions, attachments: false },
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: noAtt, transport, sessionToChannel: () => "c" },
      "sess",
      {
        action: "post",
        content: "a",
        attachments: [{ filename: "f", content_base64: "QQ==" }],
      },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });

  it("returns error when session has no channel mapping", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      ...emptyGetStubs(),
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => undefined },
      "sess",
      { action: "post", content: "a" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
    assert.equal((r as { error: string }).error, "no_discord_channel_for_session");
  });

  it("get: single message by message_id", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      async getMessage(ch, mid) {
        assert.equal(ch, "chan-z");
        assert.equal(mid, "snow1");
        return {
          id: mid,
          channel_id: ch,
          content: "hello",
          timestamp: "t",
          author: { id: "a", username: "u", bot: false },
          attachments: [{ filename: "f.png" }],
        };
      },
      async getChannelMessages() {
        throw new Error("unexpected list");
      },
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "chan-z" },
      "sess",
      { action: "get", message_id: "snow1" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    const msgs = (r as { messages: { id: string; content: string; attachment_count: number }[] }).messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, "hello");
    assert.equal(msgs[0]!.attachment_count, 1);
  });

  it("get: latest messages uses bound channel and limit", async () => {
    let lastQuery: { limit?: number } | undefined;
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      async getMessage() {
        throw new Error("unexpected single");
      },
      async getChannelMessages(ch, q) {
        assert.equal(ch, "c99");
        lastQuery = q;
        return [
          {
            id: "m1",
            channel_id: ch,
            content: "a",
            timestamp: "t",
            author: { id: "1", username: "x" },
            attachments: [],
          },
        ];
      },
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c99" },
      "sess",
      { action: "get", limit: 5 },
    );
    assert.equal((r as { ok: boolean }).ok, true);
    assert.deepEqual(lastQuery, { limit: 5 });
    assert.equal((r as { messages: unknown[] }).messages.length, 1);
  });

  it("get: anchor + list_direction passes cursor to Discord", async () => {
    let lastQuery: { before?: string; limit: number } | undefined;
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      async getMessage() {
        throw new Error("unexpected single");
      },
      async getChannelMessages(_ch, q) {
        lastQuery = q as { before?: string; limit: number };
        return [];
      },
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => "c" },
      "sess",
      {
        action: "get",
        anchor_message_id: "anchor1",
        list_direction: "before",
        limit: 3,
      },
    );
    assert.deepEqual(lastQuery, { limit: 3, before: "anchor1" });
  });

  it("get: channel_id without session binding", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      async getMessage(ch) {
        assert.equal(ch, "explicit-ch");
        return {
          id: "mid",
          channel_id: ch,
          content: "x",
          timestamp: "t",
          author: {},
          attachments: [],
        };
      },
      async getChannelMessages() {
        throw new Error("unexpected");
      },
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: caps, transport, sessionToChannel: () => undefined },
      "sess",
      { action: "get", channel_id: "explicit-ch", message_id: "mid" },
    );
    assert.equal((r as { ok: boolean }).ok, true);
  });

  it("get rejected when messageGet capability off", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async createMessageWithFiles() {
        return { id: "x" };
      },
      async editMessage() {},
      async deleteMessage() {},
      ...emptyGetStubs(),
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
    const noGet = {
      ...caps,
      extensions: { ...caps.extensions, messageGet: false },
    };
    const r = await executeDiscordMessageToolAction(
      { capabilities: noGet, transport, sessionToChannel: () => "c" },
      "sess",
      { action: "get", message_id: "x" },
    );
    assert.equal((r as { ok: boolean }).ok, false);
  });
});
