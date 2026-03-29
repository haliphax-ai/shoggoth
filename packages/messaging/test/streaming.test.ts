import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createDiscordStreamingOutbound } from "../src/streaming";
import { discordCapabilityDescriptor } from "../src/capabilities";
import type { DiscordRestTransport } from "../src/discord/transport";

describe("Streaming outbound Discord", () => {
  let createBodies: unknown[];
  let editBodies: { content: string }[];

  beforeEach(() => {
    createBodies = [];
    editBodies = [];
  });

  it("creates placeholder then edits in place with cumulative content", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage(_channelId, body) {
        createBodies.push(body);
        return { id: "stream-msg-1" };
      },
      async editMessage(_channelId, _messageId, body) {
        editBodies.push(body);
      },
    };
    const caps = discordCapabilityDescriptor();
    const stream = createDiscordStreamingOutbound({ transport, capabilities: caps, channelId: "ch-1" });
    const handle = await stream.start();
    assert.equal(createBodies.length, 1);
    await handle.setFullContent("part");
    await handle.setFullContent("partial");
    await handle.setFullContent("partial output");
    assert.equal(editBodies.length, 3);
    assert.equal(editBodies[2]!.content, "partial output");
  });

  it("truncates to Discord content limit", async () => {
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "m" };
      },
      async editMessage(_c, _m, body) {
        editBodies.push(body);
      },
    };
    const stream = createDiscordStreamingOutbound({
      transport,
      capabilities: discordCapabilityDescriptor(),
      channelId: "c",
      maxContentLength: 10,
    });
    const handle = await stream.start();
    await handle.setFullContent("123456789012345");
    assert.equal(editBodies[0]!.content.length, 10);
    assert.equal(editBodies[0]!.content, "1234567890");
  });

  it("throws if adapter does not advertise streaming", async () => {
    const caps = discordCapabilityDescriptor();
    const noStream = {
      ...caps,
      extensions: { ...caps.extensions, streamingOutbound: false },
    };
    const transport: DiscordRestTransport = {
      async openDmChannel() {
        return "dm";
      },
      async createMessage() {
        return { id: "x" };
      },
      async editMessage() {},
    };
    const stream = createDiscordStreamingOutbound({
      transport,
      capabilities: noStream,
      channelId: "c",
    });
    await assert.rejects(() => stream.start(), /streaming/i);
  });
});
