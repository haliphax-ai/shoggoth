import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../../daemon/test/helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { defaultConfig } from "@shoggoth/shared";
import {
  createLogger,
  defaultMigrationsDir,
  loadDaemonNotices,
  migrate,
  createSessionStore,
  TieredTurnQueue,
  setTurnQueue,
  setPresentationNoticeResolver,
} from "@shoggoth/daemon/lib";
import { startDiscordPlatform } from "../src/platform";
import type { DiscordMessagingRuntime } from "../src/bridge";
import { daemonNotice, setNoticeResolver } from "../src/notices";
import type { OobTurnBannerHandle } from "@shoggoth/daemon/lib";

loadDaemonNotices();
setNoticeResolver(daemonNotice);
setPresentationNoticeResolver(daemonNotice);

const SESSION_URN = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
const UNBOUND_URN = "agent:test:discord:channel:00000000-0000-0000-0000-00000000dead";

type SentMessage = { readonly channelId: string; readonly content: string };

/** Build a DiscordMessagingRuntime stub whose streaming outbound records edits. */
function buildDiscordStub(opts: {
  readonly sent: SentMessage[];
  readonly streamingSupported: boolean;
  readonly routes: { readonly channelId: string; readonly sessionId: string }[];
}): DiscordMessagingRuntime {
  const stubTransport: DiscordMessagingRuntime["discordRestTransport"] = {
    async openDmChannel() {
      return "dm-channel-stub";
    },
    async createMessage(channelId: string, body: { content?: string }) {
      opts.sent.push({ channelId, content: body.content ?? "" });
      return { id: `m${opts.sent.length}` };
    },
    async createMessageWithFiles() {
      return { id: "noop" };
    },
    async editMessage(channelId: string, messageId: string, body: { content?: string }) {
      void messageId;
      const ix = opts.sent.findIndex((m) => m.channelId === channelId);
      if (ix >= 0) opts.sent[ix] = { channelId, content: body.content ?? "" };
    },
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
    async createMessageReaction() {},
    async triggerTypingIndicator() {},
  };

  const capabilities = discordCapabilityDescriptor();
  if (!opts.streamingSupported) {
    (capabilities.extensions as Record<string, unknown>).streamingOutbound = false;
  }

  const streamingOutbound = () => {
    const channelId = "c1";
    let lastText = "…";
    let barLine: string | null = null;
    return {
      async start() {
        const created = await stubTransport.createMessage(channelId, { content: "…" });
        const messageId = created.id;
        const apply = async () => {
          const body = barLine === null ? lastText : `${lastText}\n\n${barLine}`;
          await stubTransport.editMessage(channelId, messageId, { content: body });
        };
        return {
          messageId,
          async setFullContent(text: string) {
            lastText = text;
            await apply();
          },
          async pushUpdate(text: string) {
            lastText = text;
            await apply();
          },
          async setStatusBar(line: string | null) {
            barLine = line;
            await apply();
          },
        };
      },
    };
  };

  return {
    stop: async () => {},
    gateway: {
      stop: async () => {},
      getBotUserId: () => undefined,
    },
    discordBotUserId: undefined,
    outbound: {
      sendDiscord: async () => ({ channelId: "c1", messageId: "mid" }),
    },
    discordRestTransport: stubTransport,
    streamingForSession: (sessionId: string) => {
      // Mirror the real bridge: no streaming capability, or an unbound session
      // (no route), both yield no streaming outbound.
      if (!opts.streamingSupported) return undefined;
      const bound = opts.routes.some((r) => r.sessionId === sessionId);
      if (!bound) return undefined;
      return streamingOutbound();
    },
    bus: {
      deliver: () => {},
      subscribe: () => () => {},
    },
    capabilities,
    registerPlatformThreadBinding: () => () => {},
    notifyAgentTypingForSession: async () => {},
    routes: opts.routes,
  } as unknown as DiscordMessagingRuntime;
}

describe("oobTurnBanner (issue #363)", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-oob-banner-"));
    db = new Database(join(tmp, "s.db"));
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: SESSION_URN, workspacePath: tmp });
    setTurnQueue(new TieredTurnQueue());
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  async function buildPlatform(streamingSupported: boolean) {
    const sent: SentMessage[] = [];
    const routes = [{ channelId: "c1", sessionId: SESSION_URN }];
    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord: buildDiscordStub({ sent, streamingSupported, routes }),
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "ok",
              toolCalls: [],
              usedProviderId: "p1",
              usedModel: "m1",
            };
          },
        }),
      },
    });
    return { platform, sent };
  }

  it("begin posts a processing banner and finish edits it into the terminal banner", async () => {
    const { platform, sent } = await buildPlatform(true);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: SESSION_URN,
      processing: "> ⏰ Processing timer: *wake up* `t-1` …",
    });
    assert.ok(handle, "begin should return a handle when streaming is supported");
    assert.equal(handle.sessionId, SESSION_URN);

    // Processing banner landed on the bound channel.
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.channelId, "c1");
    assert.equal(sent[0]!.content, "> ⏰ Processing timer: *wake up* `t-1` …");

    await platform.oobTurnBanner.finish({
      handle,
      terminal: "> ⏰ ✅ Timer processed: `t-1`",
      content: "Did the thing.",
    });

    // The SAME message was edited in place (no second message posted).
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.content, /^> ⏰ ✅ Timer processed: `t-1`/);
    assert.match(sent[0]!.content, /Did the thing\./);
  });

  it("setStatusBar streams a live bar render into the banner message", async () => {
    const { platform, sent } = await buildPlatform(true);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: SESSION_URN,
      processing: "> 🗨️ Processing incoming message from `s1` …",
    });
    assert.ok(handle);

    await handle.setStatusBar("⏳ starting · #3");

    // Bar is appended to the banner message body.
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.content, /⏳ starting · #3/);
    assert.match(sent[0]!.content, /^> 🗨️ Processing incoming message/);
  });

  it("finish folds the terminal status bar into the body exactly once, appended last", async () => {
    const { platform, sent } = await buildPlatform(true);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: SESSION_URN,
      processing: "> ⚙️ Processing workflow notification `wf-1` …",
    });
    assert.ok(handle);
    // Live bar render streamed mid-turn (stale by the time finish lands).
    await handle.setStatusBar("✅ done · #1");

    await platform.oobTurnBanner.finish({
      handle,
      terminal: "> ⚙️ ✅ Processed workflow notification from `wf-1`",
      content: "Did the thing.",
      statusBar: "✅ done · #2",
    });

    // The SAME message was edited in place. The stale live bar was cleared
    // and the terminal bar line lands exactly once, appended last.
    const body = sent[0]!.content;
    assert.equal(sent.length, 1);
    assert.match(body, /^> ⚙️ ✅ Processed workflow notification from `wf-1`/);
    assert.match(body, /Did the thing\./);
    assert.equal(body.split("✅ done · #2").length - 1, 1, "terminal bar must appear exactly once");
    assert.ok(body.endsWith("✅ done · #2"), "terminal bar must be appended last");
    assert.ok(!body.includes("✅ done · #1"), "stale live bar must be cleared");
  });

  it("finish without a statusBar omits the bar from the terminal body", async () => {
    const { platform, sent } = await buildPlatform(true);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: SESSION_URN,
      processing: "> ⚙️ Processing workflow notification `wf-2` …",
    });
    assert.ok(handle);
    await handle.setStatusBar("✅ done · #1");

    await platform.oobTurnBanner.finish({
      handle,
      terminal: "> ⚙️ ✅ Processed workflow notification from `wf-2`",
    });

    const body = sent[0]!.content;
    assert.equal(sent.length, 1);
    assert.match(body, /^> ⚙️ ✅ Processed workflow notification from `wf-2`/);
    assert.ok(!body.includes("✅ done · #1"), "stale live bar must be cleared");
  });

  it("begin resolves undefined when the session is not surface-bound", async () => {
    const { platform } = await buildPlatform(true);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: UNBOUND_URN,
      processing: "> ⏰ Processing timer: *x* `t-9` …",
    });
    assert.equal(handle, undefined);
  });

  it("begin resolves undefined when the platform cannot edit messages", async () => {
    const { platform } = await buildPlatform(false);

    const handle = await platform.oobTurnBanner.begin({
      sessionId: SESSION_URN,
      processing: "> ⏰ Processing timer: *x* `t-2` …",
    });
    assert.equal(handle, undefined);
  });

  it("finish is a no-op when the session is not surface-bound", async () => {
    const { platform, sent } = await buildPlatform(true);
    const orphan: OobTurnBannerHandle = {
      sessionId: UNBOUND_URN,
      setStatusBar: async () => {},
    };
    await platform.oobTurnBanner.finish({
      handle: orphan,
      terminal: "> ⏰ ✅ Timer processed: `t-3`",
    });
    assert.equal(sent.length, 0);
  });
});
