import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createOutboundSender } from "../src/outbound";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { createOutboundMessage, type InternalMessage } from "../src/model";
import type { DiscordRestTransport } from "../src/discord/transport";

describe("Outbound send path", () => {
  let calls: { method: string; channelId: string; body: unknown }[];
  let transport: DiscordRestTransport;

  beforeEach(() => {
    calls = [];
    transport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage(channelId, body) {
        calls.push({ method: "createMessage", channelId, body });
        return { id: "sent-1" };
      },
      async createMessageWithFiles(channelId, body) {
        calls.push({ method: "createMessageWithFiles", channelId, body });
        return { id: "sent-2" };
      },
      async editMessage(channelId, messageId, body) {
        calls.push({ method: "editMessage", channelId, body: { ...body, messageId } });
      },
      async deleteMessage() {},
      async getMessage(ch: string) {
        return { id: "m", channel_id: ch, content: "", timestamp: "", author: {}, attachments: [] };
      },
      async getChannelMessages() {
        return [];
      },
      async createThreadFromMessage() {
        return { id: "t" };
      },
      async deleteChannel() {},
      async createMessageReaction() {},
      async triggerTypingIndicator() {},
    };
  });

  it("sends text when extensions are supported", async () => {
    const caps = discordCapabilityDescriptor();
    const sender = createOutboundSender({
      capabilities: caps,
      transport,
      sessionToChannel: () => "chan-99",
    });
    const msg = createOutboundMessage({
      id: "out-1",
      sessionId: "sess-alpha",
      createdAt: "2026-03-27T21:10:00.000Z",
      body: "hi discord",
    });
    const ref = await sender.sendDiscord(msg);
    assert.equal(ref.messageId, "sent-1");
    assert.equal(ref.channelId, "chan-99");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "createMessage");
    assert.deepEqual(calls[0]!.body, { content: "hi discord" });
  });

  it("rejects outbound with unsupported extension for this adapter", async () => {
    const caps = discordCapabilityDescriptor();
    const sender = createOutboundSender({
      capabilities: { ...caps, extensions: { ...caps.extensions, attachments: false } },
      transport,
      sessionToChannel: () => "c",
    });
    const msg: InternalMessage = createOutboundMessage({
      id: "out-2",
      sessionId: "s",
      createdAt: "2026-03-27T21:10:00.000Z",
      body: "x",
      extensions: { attachments: [{ id: "1", url: "u", filename: "f" }] },
    });
    await assert.rejects(() => sender.sendDiscord(msg), /attachments not supported/i);
  });
});
