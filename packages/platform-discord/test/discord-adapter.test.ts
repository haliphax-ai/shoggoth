import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import {
  createDiscordAdapter,
  UnboundThreadError,
  type DiscordInboundEvent,
  type DiscordSessionRoute,
} from "../src/adapter";
import { DiscordPlatformAdapter } from "../src/discord-platform-adapter";
import type { DiscordMessagingRuntime } from "../src/bridge";
import type { DiscordStreamHandle } from "../src/streaming";

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

  it("throws UnboundThreadError when threadId is present but not bound", () => {
    const adapter = createDiscordAdapter({
      routes,
      resolveThreadSessionId: () => undefined,
    });
    const ev: DiscordInboundEvent = {
      kind: "message_create",
      messageId: "m2",
      channelId: "c1",
      guildId: "g1",
      authorId: "user-1",
      authorIsBot: false,
      content: "hello thread",
      timestampIso: "2026-03-27T21:05:00.000Z",
      threadId: "thread-unbound",
    };
    assert.throws(
      () => adapter.inboundToInternal(ev),
      (err: unknown) =>
        err instanceof UnboundThreadError && err.threadChannelId === "thread-unbound",
    );
  });
});

describe("DiscordPlatformAdapter status bar", () => {
  let sentBodies: string[];

  /** Minimal structural stand-in for the parts of DiscordMessagingRuntime the adapter touches. */
  function buildRuntime(overrides: {
    streamingHandle?: DiscordStreamHandle;
    streamingAvailable?: boolean;
  }): DiscordMessagingRuntime {
    const streamingOutbound = {
      async start() {
        if (!overrides.streamingHandle) {
          throw new Error("no streaming handle configured");
        }
        return overrides.streamingHandle;
      },
    };
    return {
      stop: async () => {},
      gateway: {} as never,
      outbound: {
        async sendDiscord(msg: { body: string }) {
          sentBodies.push(msg.body);
          return { channelId: "c1", messageId: "m1" };
        },
      },
      discordRestTransport: {} as never,
      notifyAgentTypingForSession: async () => {},
      streamingForSession: () => (overrides.streamingAvailable ? streamingOutbound : undefined),
      bus: {} as never,
      capabilities: {} as never,
      routes: [],
      discordBotUserId: undefined,
    } as unknown as DiscordMessagingRuntime;
  }

  function buildAdapter(runtime: DiscordMessagingRuntime): DiscordPlatformAdapter {
    return new DiscordPlatformAdapter({
      discord: runtime,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
  }

  beforeEach(() => {
    sentBodies = [];
  });

  it("stream handles expose setStatusBar that forwards to the underlying handle", async () => {
    const received: (string | null)[] = [];
    const underlying: DiscordStreamHandle = {
      messageId: "m-1",
      setFullContent: async () => {},
      pushUpdate: async () => {},
      setStatusBar: async (line: string | null) => {
        received.push(line);
      },
    };
    const adapter = buildAdapter(
      buildRuntime({ streamingHandle: underlying, streamingAvailable: true }),
    );
    const handle = await adapter.startStream("sess-alpha");
    assert.equal(typeof handle.setStatusBar, "function");
    await handle.setStatusBar!("\u200b| ✓ ready |");
    await handle.setStatusBar!(null);
    assert.deepEqual(received, ["\u200b| ✓ ready |", null]);
  });

  it("sendBody appends an empty line + status bar to the body before splitting", async () => {
    const adapter = buildAdapter(buildRuntime({}));
    await adapter.sendBody("sess-alpha", "hello", { statusBar: "bar" });
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0], "hello\n\nbar");
  });

  it("sendError appends an empty line + status bar to the body before slicing", async () => {
    const adapter = buildAdapter(buildRuntime({}));
    await adapter.sendError("sess-alpha", "boom", { statusBar: "bar" });
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0], "boom\n\nbar");
  });

  it("sendBody leaves the body untouched when no statusBar is given", async () => {
    const adapter = buildAdapter(buildRuntime({}));
    await adapter.sendBody("sess-alpha", "plain");
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0], "plain");
  });
});
