import { describe, it, assert, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { closeTestDb } from "../../daemon/test/helpers/close-test-db";
import { createAgentToAgentBus, createInboundMessage } from "@shoggoth/messaging";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { defaultConfig } from "@shoggoth/shared";
import {
  createLogger,
  daemonNotice,
  defaultMigrationsDir,
  loadDaemonNotices,
  migrate,
  createSessionStore,
  TieredTurnQueue,
  setTurnQueue,
  setPresentationNoticeResolver,
} from "@shoggoth/daemon/lib";
import { setNoticeResolver } from "../src/notices";
import { startDiscordPlatform } from "../src/platform";
import type { DiscordMessagingRuntime } from "../src/bridge";

// Wire daemon notice resolver so daemonNotice() works in tests.
loadDaemonNotices();
setNoticeResolver(daemonNotice);
setPresentationNoticeResolver(daemonNotice);

const SESSION_URN = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";

interface ReactionCall {
  readonly kind: "add" | "remove";
  readonly channelId: string;
  readonly messageId: string;
  readonly emoji: string;
}

/** REST transport stub capturing reaction calls (other members are inert stubs). */
function stubTransport(
  reactionCalls: ReactionCall[],
): DiscordMessagingRuntime["discordRestTransport"] {
  return {
    async openDmChannel() {
      return "dm-channel-stub";
    },
    async createMessage() {
      return { id: "noop" };
    },
    async createMessageWithFiles() {
      return { id: "noop" };
    },
    async editMessage() {},
    async deleteMessage() {},
    async getMessage() {
      return {
        id: "stub",
        channel_id: "c",
        content: "",
        timestamp: "",
        author: {},
        attachments: [],
      };
    },
    async getChannelMessages() {
      return [];
    },
    async createThreadFromMessage() {
      return { id: "thread-stub" };
    },
    async createThread() {
      return { id: "thread-stub" };
    },
    async deleteChannel() {},
    async createMessageReaction(channelId, messageId, emoji) {
      reactionCalls.push({ kind: "add", channelId, messageId, emoji });
    },
    async deleteMessageReaction(channelId, messageId, emoji) {
      reactionCalls.push({ kind: "remove", channelId, messageId, emoji });
    },
    async triggerTypingIndicator() {},
  } as DiscordMessagingRuntime["discordRestTransport"];
}

describe("queued operator message indication", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-queued-msg-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: SESSION_URN, workspacePath: tmp });
    setTurnQueue(new TieredTurnQueue());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeTestDb(db, tmp);
  });

  it("reacts ⏳ on a queued operator message and removes the reaction when its turn starts", async () => {
    const sent: { body: string }[] = [];
    const reactionCalls: ReactionCall[] = [];
    const bus = createAgentToAgentBus();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let modelCalls = 0;

    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: { stop: async () => {}, getBotUserId: () => undefined },
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c1", messageId: "mid" };
        },
      },
      discordRestTransport: stubTransport(reactionCalls),
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: async () => {},
      routes: [{ channelId: "c1", sessionId: SESSION_URN }],
      resolveOutboundChannelIdForSession: () => "c1",
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            modelCalls++;
            if (modelCalls === 1) await firstGate;
            return {
              content: `reply-${modelCalls}`,
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    // First message: its turn starts and blocks on the gate.
    bus.deliver(
      SESSION_URN,
      createInboundMessage({
        id: "d1",
        sessionId: SESSION_URN,
        createdAt: new Date().toISOString(),
        body: "first",
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    assert.equal(modelCalls, 1, "the first turn must be in flight");

    // Second message: the session is busy, so it queues up with a ⏳ reaction.
    bus.deliver(
      SESSION_URN,
      createInboundMessage({
        id: "d2",
        sessionId: SESSION_URN,
        createdAt: new Date().toISOString(),
        body: "second",
      }),
    );
    await vi.advanceTimersByTimeAsync(20);

    assert.deepEqual(
      reactionCalls,
      [{ kind: "add", channelId: "c1", messageId: "d2", emoji: "⏳" }],
      `the queued message must carry a single ⏳ reaction, got: ${JSON.stringify(reactionCalls)}`,
    );

    // Unblock the first turn: the queued turn starts and the reaction is removed.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    assert.equal(modelCalls, 2, "the queued turn must run after the first");
    assert.deepEqual(
      reactionCalls,
      [
        { kind: "add", channelId: "c1", messageId: "d2", emoji: "⏳" },
        { kind: "remove", channelId: "c1", messageId: "d2", emoji: "⏳" },
      ],
      `the ⏳ reaction must be removed when the queued turn starts, got: ${JSON.stringify(reactionCalls)}`,
    );
    // No busy notice was posted: the reaction is the indication on this platform.
    assert.equal(
      sent.filter((s) => s.body.includes("Agent is busy")).length,
      0,
      "the reaction path must not also post the busy notice",
    );
  });

  it("replies with the busy notice when the reaction channel cannot be resolved", async () => {
    const sent: { body: string; replyToMessageId?: string }[] = [];
    const reactionCalls: ReactionCall[] = [];
    const bus = createAgentToAgentBus();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let modelCalls = 0;

    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: { stop: async () => {}, getBotUserId: () => undefined },
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body, replyToMessageId: msg.extensions.replyToMessageId });
          return { channelId: "c1", messageId: "mid" };
        },
      },
      discordRestTransport: stubTransport(reactionCalls),
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: async () => {},
      routes: [{ channelId: "c1", sessionId: SESSION_URN }],
      // No resolveOutboundChannelIdForSession: reactions cannot be addressed.
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            modelCalls++;
            if (modelCalls === 1) await firstGate;
            return {
              content: `reply-${modelCalls}`,
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    bus.deliver(
      SESSION_URN,
      createInboundMessage({
        id: "d1",
        sessionId: SESSION_URN,
        createdAt: new Date().toISOString(),
        body: "first",
      }),
    );
    await vi.advanceTimersByTimeAsync(20);

    bus.deliver(
      SESSION_URN,
      createInboundMessage({
        id: "d2",
        sessionId: SESSION_URN,
        createdAt: new Date().toISOString(),
        body: "second",
      }),
    );
    await vi.advanceTimersByTimeAsync(20);

    assert.equal(reactionCalls.length, 0, "no reaction can be placed without a channel id");
    const notices = sent.filter((s) => s.body.includes("Agent is busy"));
    assert.equal(notices.length, 1, "the queued message must get exactly one busy notice");
    assert.equal(notices[0]!.replyToMessageId, "d2", "the notice must reply to the queued message");

    releaseFirst();
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();
  });
});
