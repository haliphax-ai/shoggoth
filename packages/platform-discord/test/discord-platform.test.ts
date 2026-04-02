import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createAgentToAgentBus,
  createInboundMessage,
} from "@shoggoth/messaging";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { ModelHttpError } from "@shoggoth/models";
import { defaultConfig } from "@shoggoth/shared";
import type { ShoggothMcpServerEntry } from "@shoggoth/shared";
import { createHitlDiscordNoticeRegistry } from "../src/hitl/notice-registry";
import {
  createHitlPendingResolutionStack,
  createLogger,
  daemonNotice,
  defaultMigrationsDir,
  loadDaemonNotices,
  migrate,
  createSessionStore,
  transcriptRowsToModelChatMessages,
} from "@shoggoth/daemon/lib";
import { formatDiscordPlatformErrorUserText } from "../src/errors";
import {
  formatDiscordPlatformDegradedPrefix,
  formatDiscordPlatformModelTagFooter,
  startDiscordPlatform,
} from "../src/platform";
import {
  buildHitlQueuedNoticeLines,
  formatHitlPayloadExcerpt,
  HITL_NOTICE_PAYLOAD_MAX_CHARS,
} from "../src/hitl/notifier";
import type { PendingActionRow, Logger } from "../src/daemon-types";
import type { DiscordMessagingRuntime } from "../src/bridge";
import { setNoticeResolver } from "../src/notices";

// Wire daemon notice resolver so platform-discord's daemonNotice() works in tests.
loadDaemonNotices();
setNoticeResolver(daemonNotice);

/** Stub type for connectShoggothMcpServers (daemon internal) */
type ConnectShoggothMcpServersFn = (servers: ShoggothMcpServerEntry[]) => Promise<{
  pool: { externalSources: unknown[]; close: () => Promise<void> };
  external: () => Promise<{ resultJson: string }>;
}>;

const stubDiscordRestTransport: DiscordMessagingRuntime["discordRestTransport"] = {
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
    return { id: "stub", channel_id: "c", content: "", timestamp: "", author: {}, attachments: [] };
  },
  async getChannelMessages() {
    return [];
  },
  async createThreadFromMessage() {
    return { id: "thread-stub" };
  },
  async deleteChannel() {},
  async createMessageReaction() {},
  async triggerTypingIndicator() {},
};

const stubNotifyAgentTyping: DiscordMessagingRuntime["notifyAgentTypingForSession"] = async () => {};

const stubDiscordGatewaySession: DiscordMessagingRuntime["gateway"] = {
  stop: async () => {},
  getBotUserId: () => undefined,
};

describe("discord platform helpers", () => {
  it("formatDiscordPlatformDegradedPrefix is empty when not degraded", () => {
    assert.equal(formatDiscordPlatformDegradedPrefix(undefined), "");
    assert.equal(
      formatDiscordPlatformDegradedPrefix({ degraded: false, usedModel: "m", usedProviderId: "p" }),
      "",
    );
  });

  it("formatDiscordPlatformDegradedPrefix includes model when degraded", () => {
    const s = formatDiscordPlatformDegradedPrefix({
      degraded: true,
      usedModel: "backup-m",
      usedProviderId: "env-default",
    });
    assert.match(s, /backup-m/);
    assert.match(s, /env-default/);
  });

  it("formatDiscordPlatformModelTagFooter is empty unless env flag and meta", () => {
    assert.equal(
      formatDiscordPlatformModelTagFooter({ SHOGGOTH_DISCORD_MODEL_TAG: "1" }, undefined),
      "",
    );
    assert.equal(
      formatDiscordPlatformModelTagFooter(
        {},
        { degraded: false, usedModel: "m1", usedProviderId: "p1" },
      ),
      "",
    );
    const foot = formatDiscordPlatformModelTagFooter(
      { SHOGGOTH_DISCORD_MODEL_TAG: "1" },
      { degraded: false, usedModel: "m1", usedProviderId: "p1" },
    );
    assert.match(foot, /m1/);
    assert.match(foot, /p1/);
  });

  it("transcriptRowsToModelChatMessages restores toolCalls from dedicated field", () => {
    const chat = transcriptRowsToModelChatMessages([
      { seq: 1, role: "user", content: "u", toolCallId: null },
      {
        seq: 2,
        role: "assistant",
        content: null,
        toolCallId: null,
        toolCalls: [{ id: "t1", name: "builtin.read", argsJson: "{}" }],
      },
      { seq: 3, role: "tool", content: "{}", toolCallId: "t1" },
    ]);
    assert.equal(chat.length, 3);
    assert.equal(chat[1]!.role, "assistant");
    assert.ok("toolCalls" in chat[1]! && (chat[1] as { toolCalls: unknown[] }).toolCalls.length === 1);
  });
});

describe("formatDiscordPlatformErrorUserText", () => {
  it("maps ModelHttpError statuses to friendly copy", () => {
    assert.match(formatDiscordPlatformErrorUserText(new ModelHttpError(429, "x")), /rate-limited/i);
    assert.match(
      formatDiscordPlatformErrorUserText(new ModelHttpError(503, "x")),
      /unavailable/i,
    );
    assert.match(formatDiscordPlatformErrorUserText(new ModelHttpError(500, "x")), /500/i);
    assert.match(formatDiscordPlatformErrorUserText(new ModelHttpError(401, "x")), /401/i);
    assert.match(formatDiscordPlatformErrorUserText(new ModelHttpError(418, "x")), /418/);
    assert.match(
      formatDiscordPlatformErrorUserText(
        new ModelHttpError(400, "Bad Request", "invalid_request: tool schema"),
      ),
      /400/i,
    );
    assert.match(
      formatDiscordPlatformErrorUserText(
        new ModelHttpError(400, "Bad Request", "invalid_request: tool schema"),
      ),
      /tool schema/i,
    );
  });

  it("maps fetch-like TypeError to a network hint", () => {
    assert.match(
      formatDiscordPlatformErrorUserText(new TypeError("fetch failed")),
      /Network error/i,
    );
  });

  it("maps hitl_pending to approval copy with id, not stack", () => {
    const t = formatDiscordPlatformErrorUserText(
      new Error("hitl_pending:pend-uuid-1\n    at foo (bar.js:1:1)"),
    );
    assert.match(t, /pend-uuid-1/);
    assert.match(t, /approval/i);
    assert.equal(t.includes("at foo"), false);
  });

  it("truncates generic Error to first line", () => {
    const t = formatDiscordPlatformErrorUserText(new Error("line1\nline2\nline3"));
    assert.match(t, /^line1$/);
  });
});

describe("discord-hitl-notifier", () => {
  function row(overrides: Partial<PendingActionRow>): PendingActionRow {
    return {
      id: "pend-1",
      sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
      correlationId: undefined,
      toolName: "builtin.write",
      resourceSummary: undefined,
      payload: {},
      riskTier: "caution",
      status: "pending",
      denialReason: undefined,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      resolvedAt: undefined,
      resolverPrincipal: undefined,
      ...overrides,
    };
  }

  it("formatHitlPayloadExcerpt truncates long JSON", () => {
    const long = { path: "p", content: "x".repeat(800) };
    const ex = formatHitlPayloadExcerpt(long);
    assert.ok(ex);
    assert.ok(ex!.endsWith("…"));
    assert.equal(ex!.length, HITL_NOTICE_PAYLOAD_MAX_CHARS);
  });

  it("buildHitlQueuedNoticeLines includes payload excerpt", () => {
    const lines = buildHitlQueuedNoticeLines(
      row({
        payload: {
          argsJson: JSON.stringify({ path: "hitl-notify.txt", content: "x" }),
          toolCallId: "tw1",
        },
      }),
    );
    const text = lines.join("\n");
    assert.match(text, /payload \(truncated\):/);
    assert.match(text, /hitl-notify\.txt/);
  });
});

describe("startDiscordPlatform", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-discord-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "agent:test:discord:10000000-0000-4000-8000-000000000001", workspacePath: tmp });
  });

  /** Unblocks runToolLoop when a HITL row is queued (same store as Discord platform). */
  async function approveFirstPendingWhenQueued(
    hitlStack: ReturnType<typeof createHitlPendingResolutionStack>,
    sessionId: string,
  ): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const rows = hitlStack.pending.listPendingForSession(sessionId);
      if (rows.length > 0) {
        assert.ok(hitlStack.pending.approve(rows[0]!.id, "test-operator"));
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail("timed out waiting for HITL pending row");
  }

  function createHitlWriteToolModelStub() {
    let modelRound = 0;
    return () => ({
      async completeWithTools() {
        modelRound++;
        if (modelRound === 1) {
          return {
            content: "Using write",
            toolCalls: [
              {
                id: "tw1",
                name: "builtin.write",
                arguments: JSON.stringify({ path: "hitl-notify.txt", content: "x" }),
              },
            ],
            usedModel: "m1",
            usedProviderId: "p1",
          };
        }
        return { content: "Done", toolCalls: [], usedModel: "m1", usedProviderId: "p1" };
      },
    });
  }

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs tool loop and sends Discord reply with degraded banner", async () => {
    const sent: { body: string }[] = [];
    const typingSessions: string[] = [];
    const bus = createAgentToAgentBus();
    const sessionUrn = "agent:test:discord:10000000-0000-4000-8000-000000000001";
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: async (sid) => {
        typingSessions.push(sid);
      },
      routes: [{ channelId: "c1", sessionId: sessionUrn }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: {
        ...defaultConfig(tmp),
        agents: {
          list: { test: { displayName: "LabBot" } },
        },
      },
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "Hello (failover hop).",
              toolCalls: [],
              usedProviderId: "backup",
              usedModel: "m2",
              degraded: true,
            };
          },
        }),
      },
    });

    bus.deliver(
      sessionUrn,
      createInboundMessage({
        id: "d1",
        sessionId: sessionUrn,
        createdAt: new Date().toISOString(),
        body: "ping",
      }),
    );

    await new Promise((r) => setTimeout(r, 500));
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /Degraded/);
    assert.match(sent[0]!.body, /\*\*🦑 LabBot:\*\*\n/);
    assert.match(sent[0]!.body, /Hello/);
    assert.ok(typingSessions.length >= 1);
    assert.ok(typingSessions.every((s) => s === sessionUrn));
  });

  it("on tool loop ModelHttpError 429, sends friendly Discord error body", async () => {
    const sent: { body: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "", toolCalls: [] };
          },
        }),
        runToolLoopImpl: async () => {
          throw new ModelHttpError(429, "upstream", '{"error":"rate"}');
        },
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "ping",
      }),
    );

    await new Promise((r) => setTimeout(r, 500));
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /⚠️/);
    assert.match(sent[0]!.body, /rate-limited/i);
    assert.equal(sent[0]!.body.includes("upstream"), false);
    assert.equal(sent[0]!.body.includes("Too Many"), false);
  });

  it("appends model tag footer when SHOGGOTH_DISCORD_MODEL_TAG=1", async () => {
    const sent: { body: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      env: { SHOGGOTH_DISCORD_MODEL_TAG: "1" },
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "Hi.",
              toolCalls: [],
              usedProviderId: "openai",
              usedModel: "gpt-test",
              degraded: false,
            };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "ping",
      }),
    );

    await new Promise((r) => setTimeout(r, 500));
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /Hi\./);
    assert.match(sent[0]!.body, /gpt-test/);
    assert.match(sent[0]!.body, /openai/);
  });

  it("mcp poolScope global invokes connect once at startup", async () => {
    let connectCalls = 0;
    const stubConnect: ConnectShoggothMcpServersFn = async () => {
      connectCalls++;
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "global",
      servers: [{ id: "s1", transport: "stdio", command: "true", args: [] }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    assert.equal(connectCalls, 1);
    await platform.stop();
  });

  it("mcp poolScope per_session does not connect until first inbound turn; one pool per session id", async () => {
    let connectCalls = 0;
    const stubConnect: ConnectShoggothMcpServersFn = async () => {
      connectCalls++;
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    createSessionStore(db).create({ id: "agent:test:discord:10000000-0000-4000-8000-000000000002", workspacePath: tmp });

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [
        { channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" },
        { channelId: "c2", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002" },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      servers: [{ id: "s1", transport: "stdio", command: "true", args: [] }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    assert.equal(connectCalls, 0);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 2);

    await platform.stop();
  });

  it("per-session MCP pool reconnects after perSessionIdleTimeoutMs", async () => {
    let connectCalls = 0;
    const stubConnect: ConnectShoggothMcpServersFn = async () => {
      connectCalls++;
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      perSessionIdleTimeoutMs: 40,
      servers: [{ id: "s1", transport: "stdio", command: "true", args: [] }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    await new Promise((r) => setTimeout(r, 120));

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 2);

    await platform.stop();
  });

  it("perSessionIdleTimeoutMs 0 keeps a single per-session MCP pool across idle gaps", async () => {
    let connectCalls = 0;
    const stubConnect: ConnectShoggothMcpServersFn = async () => {
      connectCalls++;
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      perSessionIdleTimeoutMs: 0,
      servers: [{ id: "s1", transport: "stdio", command: "true", args: [] }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    await new Promise((r) => setTimeout(r, 120));

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    await platform.stop();
  });

  it("per-server poolScope mixed: global connect once at startup, per_session subset once per session id", async () => {
    const connectLog: { ids: string[] }[] = [];
    const stubConnect: ConnectShoggothMcpServersFn = async (servers) => {
      connectLog.push({ ids: servers.map((s) => s.id) });
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    createSessionStore(db).create({ id: "agent:test:discord:10000000-0000-4000-8000-000000000002", workspacePath: tmp });

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [
        { channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" },
        { channelId: "c2", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002" },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      servers: [
        { id: "g", transport: "stdio", command: "true", args: [], poolScope: "global" },
        { id: "p", transport: "stdio", command: "true", args: [], poolScope: "inherit" },
      ],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    assert.equal(connectLog.length, 1);
    assert.deepStrictEqual(connectLog[0]!.ids, ["g"]);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectLog.length, 2);
    assert.deepStrictEqual(connectLog[1]!.ids, ["p"]);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectLog.length, 2);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectLog.length, 3);
    assert.deepStrictEqual(connectLog[2]!.ids, ["p"]);

    await platform.stop();
  });

  it("mixed per-server poolScope: global slice at startup, per-session slice on first turn per session", async () => {
    let connectCalls = 0;
    const connectArgs: ShoggothMcpServerEntry[][] = [];
    const stubConnect: ConnectShoggothMcpServersFn = async (servers) => {
      connectCalls++;
      connectArgs.push([...servers]);
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    createSessionStore(db).create({ id: "agent:test:discord:10000000-0000-4000-8000-000000000002", workspacePath: tmp });

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [
        { channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" },
        { channelId: "c2", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002" },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "global",
      servers: [
        { id: "indexer", transport: "stdio", command: "true", args: [] },
        {
          id: "sandbox",
          transport: "stdio",
          command: "true",
          args: [],
          poolScope: "per_session",
        },
      ],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    assert.equal(connectCalls, 1);
    assert.equal(connectArgs.length, 1);
    assert.deepEqual(
      connectArgs[0]!.map((s) => s.id),
      ["indexer"],
    );

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 2);
    assert.deepEqual(
      connectArgs[1]!.map((s) => s.id),
      ["sandbox"],
    );

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 2);

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 3);
    assert.deepEqual(
      connectArgs[2]!.map((s) => s.id),
      ["sandbox"],
    );

    await platform.stop();
  });

  it("per-server poolScope global with top-level per_session connects once at startup only", async () => {
    let connectCalls = 0;
    const connectArgs: ShoggothMcpServerEntry[][] = [];
    const stubConnect: ConnectShoggothMcpServersFn = async (servers) => {
      connectCalls++;
      connectArgs.push([...servers]);
      return {
        pool: {
          externalSources: [],
          close: async () => {},
        },
        external: async () => ({ resultJson: "{}" }),
      };
    };

    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      servers: [
        { id: "shared_index", transport: "stdio", command: "true", args: [], poolScope: "global" },
      ],
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        connectShoggothMcpServers: stubConnect,
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "ok", toolCalls: [] };
          },
        }),
      },
    });

    assert.equal(connectCalls, 1);
    assert.deepEqual(
      connectArgs[0]!.map((s) => s.id),
      ["shared_index"],
    );

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "hi",
      }),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(connectCalls, 1);

    await platform.stop();
  });

  it("posts HITL operator notification to Discord channel when SHOGGOTH_HITL_NOTIFY_CHANNEL_ID is set", async () => {
    const notifyChannelId = "channel-hitl-notify-1";
    const hitlStack = createHitlPendingResolutionStack(db);
    const createMessageCalls: { channelId: string; content: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: {
        async openDmChannel() {
          return "unused";
        },
        async createMessage(channelId, body) {
          createMessageCalls.push({ channelId, content: body.content ?? "" });
          return { id: "rest-op-1" };
        },
        async editMessage() {},
        async createMessageReaction() {},
        async triggerTypingIndicator() {},
      },
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      hitlDiscordNoticeRegistry: createHitlDiscordNoticeRegistry(),
      env: { ...process.env, SHOGGOTH_HITL_NOTIFY_CHANNEL_ID: notifyChannelId },
      deps: {
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-ch",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl",
      }),
    );

    await approveP;
    await new Promise((r) => setTimeout(r, 600));
    await platform.stop();

    const opMsgs = createMessageCalls.filter((c) => c.channelId === notifyChannelId);
    assert.equal(opMsgs.length, 1);
    assert.match(opMsgs[0]!.content, /HITL/);
    assert.match(opMsgs[0]!.content, /builtin\.write/);
    assert.match(opMsgs[0]!.content, /shoggoth hitl approve/);
    assert.match(opMsgs[0]!.content, /agent:test:discord:10000000-0000-4000-8000-000000000001/);
    assert.match(opMsgs[0]!.content, /payload \(truncated\):/);
    assert.match(opMsgs[0]!.content, /hitl-notify\.txt/);
  });

  it("posts HITL operator notification to Discord DM when SHOGGOTH_HITL_NOTIFY_DM_USER_ID is set", async () => {
    const hitlStack = createHitlPendingResolutionStack(db);
    const dmOpens: string[] = [];
    const createMessageCalls: { channelId: string; content: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
      },
      discordRestTransport: {
        async openDmChannel(userId) {
          dmOpens.push(userId);
          return "dm-ch-from-api";
        },
        async createMessage(channelId, body) {
          createMessageCalls.push({ channelId, content: body.content ?? "" });
          return { id: "rest-dm-1" };
        },
        async editMessage() {},
        async createMessageReaction() {},
        async triggerTypingIndicator() {},
      },
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const targetDmUser = "347033761822801922";
    const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      hitlDiscordNoticeRegistry: createHitlDiscordNoticeRegistry(),
      env: { ...process.env, SHOGGOTH_HITL_NOTIFY_DM_USER_ID: targetDmUser },
      deps: {
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-dm",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl dm",
      }),
    );

    await approveP;
    await new Promise((r) => setTimeout(r, 600));
    await platform.stop();

    assert.deepEqual(dmOpens, [targetDmUser]);
    const dmMsgs = createMessageCalls.filter((c) => c.channelId === "dm-ch-from-api");
    assert.equal(dmMsgs.length, 1);
    assert.match(dmMsgs[0]!.content, /HITL/);
    assert.match(dmMsgs[0]!.content, /builtin\.write/);
    assert.match(dmMsgs[0]!.content, /hitl-notify\.txt/);
  });

  it("POSTs HITL queued payload to webhook when SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL is set", async () => {
    const webhookUrl = "https://example.invalid/hitl-hook";
    const hitlStack = createHitlPendingResolutionStack(db);
    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    };

    try {
      const bus = createAgentToAgentBus();
      const discord: DiscordMessagingRuntime = {
        stop: async () => {},
        gateway: stubDiscordGatewaySession,
        discordBotUserId: undefined,
        outbound: {
          sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
        },
        discordRestTransport: stubDiscordRestTransport,
        streamingForSession: () => undefined,
        bus,
        capabilities: discordCapabilityDescriptor(),
        registerPlatformThreadBinding: () => () => {},
        notifyAgentTypingForSession: stubNotifyAgentTyping,
        routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
      };

      const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

      const platform = await startDiscordPlatform({
        db,
        config: defaultConfig(tmp),
        logger: createLogger({ component: "t", minLevel: "error" }),
        discord,
        hitlPending: hitlStack,
        env: { ...process.env, SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL: webhookUrl },
        deps: {
          createToolCallingClient: createHitlWriteToolModelStub(),
        },
      });

      bus.deliver(
        "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-wh",
          sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "trigger hitl webhook",
        }),
      );

      await approveP;
      await new Promise((r) => setTimeout(r, 600));
      await platform.stop();

      const hook = fetchCalls.find((c) => c.url === webhookUrl);
      assert.ok(hook, "expected fetch to webhook URL");
      assert.equal(hook!.init?.method, "POST");
      const rawBody = hook!.init?.body;
      assert.ok(typeof rawBody === "string");
      const parsed = JSON.parse(rawBody) as {
        event: string;
        pendingId: string;
        sessionId: string;
        tool: string;
        riskTier: string;
        payloadPreview: string | null;
      };
      assert.equal(parsed.event, "hitl.pending_queued");
      assert.equal(parsed.sessionId, "agent:test:discord:10000000-0000-4000-8000-000000000001");
      assert.equal(parsed.tool, "builtin.write");
      assert.equal(parsed.riskTier, "caution");
      assert.ok(typeof parsed.pendingId === "string" && parsed.pendingId.length > 0);
      assert.ok(typeof parsed.payloadPreview === "string" && parsed.payloadPreview.includes("hitl-notify"));
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it("sends both Discord channel message and webhook when both HITL notify env vars are set", async () => {
    const notifyChannelId = "channel-hitl-both";
    const webhookUrl = "https://example.invalid/hitl-both";
    const hitlStack = createHitlPendingResolutionStack(db);
    const createMessageCalls: { channelId: string; content: string }[] = [];
    const fetchCalls: { url: string }[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      fetchCalls.push({ url: String(input) });
      return new Response("{}", { status: 200 });
    };

    try {
      const bus = createAgentToAgentBus();
      const discord: DiscordMessagingRuntime = {
        stop: async () => {},
        gateway: stubDiscordGatewaySession,
        discordBotUserId: undefined,
        outbound: {
          sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
        },
        discordRestTransport: {
          async openDmChannel() {
            return "unused";
          },
          async createMessage(channelId, body) {
            createMessageCalls.push({ channelId, content: body.content ?? "" });
            return { id: "rest-both" };
          },
          async editMessage() {},
          async createMessageReaction() {},
          async triggerTypingIndicator() {},
        },
        streamingForSession: () => undefined,
        bus,
        capabilities: discordCapabilityDescriptor(),
        registerPlatformThreadBinding: () => () => {},
        notifyAgentTypingForSession: stubNotifyAgentTyping,
        routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
      };

      const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

      const platform = await startDiscordPlatform({
        db,
        config: defaultConfig(tmp),
        logger: createLogger({ component: "t", minLevel: "error" }),
        discord,
        hitlPending: hitlStack,
        hitlDiscordNoticeRegistry: createHitlDiscordNoticeRegistry(),
        env: {
          ...process.env,
          SHOGGOTH_HITL_NOTIFY_CHANNEL_ID: notifyChannelId,
          SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL: webhookUrl,
        },
        deps: {
          createToolCallingClient: createHitlWriteToolModelStub(),
        },
      });

      bus.deliver(
        "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-both",
          sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "trigger both",
        }),
      );

      await approveP;
      await new Promise((r) => setTimeout(r, 600));
      await platform.stop();

      assert.ok(fetchCalls.some((c) => c.url === webhookUrl));
      assert.equal(
        createMessageCalls.filter((c) => c.channelId === notifyChannelId).length,
        1,
      );
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it("does not call Discord createMessage or webhook fetch for HITL when notify env vars are unset", async () => {
    const hitlStack = createHitlPendingResolutionStack(db);
    const createMessageCalls: { channelId: string }[] = [];
    const fetchCalls: { url: string }[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      fetchCalls.push({ url: String(input) });
      return new Response("{}", { status: 200 });
    };

    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
      delete env.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
      delete env.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;

      const bus = createAgentToAgentBus();
      const discord: DiscordMessagingRuntime = {
        stop: async () => {},
        gateway: stubDiscordGatewaySession,
        discordBotUserId: undefined,
        outbound: {
          sendDiscord: async () => ({ channelId: "c", messageId: "mid" }),
        },
        discordRestTransport: {
          async openDmChannel() {
            return "unused";
          },
          async createMessage(channelId) {
            createMessageCalls.push({ channelId });
            return { id: "x" };
          },
          async editMessage() {},
          async createMessageReaction() {},
          async triggerTypingIndicator() {},
        },
        streamingForSession: () => undefined,
        bus,
        capabilities: discordCapabilityDescriptor(),
        registerPlatformThreadBinding: () => () => {},
        notifyAgentTypingForSession: stubNotifyAgentTyping,
        routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
      };

      const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

      const platform = await startDiscordPlatform({
        db,
        config: defaultConfig(tmp),
        logger: createLogger({ component: "t", minLevel: "error" }),
        discord,
        hitlPending: hitlStack,
        hitlDiscordNoticeRegistry: createHitlDiscordNoticeRegistry(),
        env,
        deps: {
          createToolCallingClient: createHitlWriteToolModelStub(),
        },
      });

      bus.deliver(
        "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-none",
          sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "hitl no notify",
        }),
      );

      await approveP;
      await new Promise((r) => setTimeout(r, 600));
      await platform.stop();

      assert.equal(createMessageCalls.length, 0);
      assert.equal(fetchCalls.length, 0);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it("posts in-session HITL notice via outbound.sendDiscord when HITL queues without notify env vars", async () => {
    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          outboundBodies.push(m.body);
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env };
        delete e.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
        delete e.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
        delete e.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;
        e.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION = "1";
        return e;
      })(),
      deps: {
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-in-thread",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl in thread",
      }),
    );

    await approveP;
    await new Promise((r) => setTimeout(r, 600));
    await platform.stop();

    const hitlBodies = outboundBodies.filter((b) => b.includes("HITL") && b.includes("shoggoth hitl approve"));
    assert.ok(hitlBodies.length >= 1, "expected at least one outbound HITL notice");
    assert.match(hitlBodies[0]!, /builtin\.write/);
    assert.match(hitlBodies[0]!, /agent:test:discord:10000000-0000-4000-8000-000000000001/);
    assert.match(hitlBodies[0]!, /hitl-notify\.txt/);
  });

  it("does not post in-session HITL notice when SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0", async () => {
    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          outboundBodies.push(m.body);
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env };
        delete e.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
        delete e.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
        delete e.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;
        e.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION = "0";
        return e;
      })(),
      deps: {
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-no-in-thread",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl no in-thread",
      }),
    );

    await approveP;
    await new Promise((r) => setTimeout(r, 600));
    await platform.stop();

    const hitlBodies = outboundBodies.filter((b) => b.includes("HITL") && b.includes("shoggoth hitl approve"));
    assert.equal(hitlBodies.length, 0, "in-thread HITL reply should be suppressed");
  });

  it("disables in-session HITL when discord.hitlReplyInSession is false (merged env)", async () => {
    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          outboundBodies.push(m.body);
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, "agent:test:discord:10000000-0000-4000-8000-000000000001");
    const cfg = { ...defaultConfig(tmp), platforms: { discord: { enabled: true, hitlReplyInSession: false as const } } };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env };
        delete e.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
        delete e.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
        delete e.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;
        delete e.SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION;
        return e;
      })(),
      deps: {
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-config-off",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl config off",
      }),
    );

    await approveP;
    await new Promise((r) => setTimeout(r, 600));
    await platform.stop();

    const hitlBodies = outboundBodies.filter((b) => b.includes("HITL") && b.includes("shoggoth hitl approve"));
    assert.equal(hitlBodies.length, 0);
  });

  it("silently ignores inbound when discord.ownerUserId is set and author is not owner", async () => {
    const sent: { body: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const ownerId = "111111111111111111";
    const cfg = { ...defaultConfig(tmp), platforms: { discord: { enabled: true, ownerUserId: ownerId } } };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "nope", toolCalls: [], usedModel: "m", usedProviderId: "p" };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-nonowner",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "hi",
        extensions: {
          platform: {
            discord: {
              authorId: "222222222222222222",
              authorIsBot: false,
              isSelf: false,
              isOwner: false,
            },
          },
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 400));
    await platform.stop();

    assert.equal(sent.length, 0);
  });

  it("forwards inbound when discord.ownerUserId is set and extensions.platform.discord.isOwner is true", async () => {
    const sent: { body: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (msg) => {
          sent.push({ body: msg.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001" }],
    };

    const ownerId = "111111111111111111";
    const cfg = { ...defaultConfig(tmp), platforms: { discord: { enabled: true, ownerUserId: ownerId } } };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return { content: "owner reply", toolCalls: [], usedModel: "m", usedProviderId: "p" };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-owner",
        sessionId: "agent:test:discord:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "hi",
        extensions: {
          platform: {
            discord: {
              authorId: ownerId,
              authorIsBot: false,
              isSelf: false,
              isOwner: true,
            },
          },
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 400));
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /owner reply/);
  });

  it("subagent runSessionModelTurn with messaging_surface delivery fires afterHitlQueued and hitlNotifier", async () => {
    const parentSessionId = "agent:test:discord:10000000-0000-4000-8000-000000000001";
    const subagentSessionId = "agent:test:discord:10000000-0000-4000-8000-000000000001:bbbbbbbb-bbbb-4ccc-dddd-eeeeeeeeeeee";
    createSessionStore(db).create({ id: subagentSessionId, workspacePath: tmp });
    createSessionStore(db).update(subagentSessionId, {
      parentSessionId,
      subagentMode: "one_shot",
    });

    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const notifierCalls: { pendingId: string; sessionId: string; tool: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          outboundBodies.push(m.body);
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: parentSessionId }],
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, subagentSessionId);

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      hitlDiscordNoticeRegistry: createHitlDiscordNoticeRegistry(),
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env };
        delete e.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
        delete e.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
        delete e.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;
        return e;
      })(),
      deps: {
        hitlNotifier: {
          onQueued(row) {
            notifierCalls.push({ pendingId: row.id, sessionId: row.sessionId, tool: row.toolName });
          },
        },
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    const turnP = platform.runSessionModelTurn({
      sessionId: subagentSessionId,
      userContent: "trigger hitl in subagent",
      delivery: {
        kind: "messaging_surface",
        userId: "discord:subagent",
        replyToMessageId: undefined,
      },
    });

    await approveP;
    const result = await turnP;
    await platform.stop();

    // hitlNotifier.onQueued was called for the subagent session
    assert.equal(notifierCalls.length, 1);
    assert.equal(notifierCalls[0]!.sessionId, subagentSessionId);
    assert.equal(notifierCalls[0]!.tool, "builtin.write");

    // afterHitlQueued fired: in-session HITL notice was sent via outbound
    const hitlBodies = outboundBodies.filter((b) => b.includes("HITL") && b.includes("shoggoth hitl approve"));
    assert.ok(hitlBodies.length >= 1, "expected at least one in-session HITL notice for subagent");
    assert.match(hitlBodies[0]!, /builtin\.write/);
    assert.match(hitlBodies[0]!, new RegExp(subagentSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The turn completed with a reply
    assert.ok(result.latestAssistantText.length > 0);
  });

  it("subagent runSessionModelTurn with internal delivery fires afterHitlQueued using parent session channel", async () => {
    const parentSessionId = "agent:test:discord:10000000-0000-4000-8000-000000000099";
    const subagentSessionId = "agent:test:discord:10000000-0000-4000-8000-000000000099:cccccccc-cccc-4ccc-dddd-eeeeeeeeeeee";
    createSessionStore(db).create({ id: parentSessionId, workspacePath: tmp });
    createSessionStore(db).create({ id: subagentSessionId, workspacePath: tmp });
    createSessionStore(db).update(subagentSessionId, {
      parentSessionId,
      subagentMode: "one_shot",
    });

    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const outboundSessionIds: string[] = [];
    const notifierCalls: { pendingId: string; sessionId: string; tool: string }[] = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          outboundBodies.push(m.body);
          outboundSessionIds.push(m.sessionId);
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: parentSessionId }],
      resolveOutboundChannelIdForSession: (sid) =>
        sid === parentSessionId ? "c1" : undefined,
    };

    const approveP = approveFirstPendingWhenQueued(hitlStack, subagentSessionId);

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      hitlPending: hitlStack,
      env: (() => {
        const e: NodeJS.ProcessEnv = { ...process.env };
        delete e.SHOGGOTH_HITL_NOTIFY_CHANNEL_ID;
        delete e.SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL;
        delete e.SHOGGOTH_HITL_NOTIFY_DM_USER_ID;
        return e;
      })(),
      deps: {
        hitlNotifier: {
          onQueued(row) {
            notifierCalls.push({ pendingId: row.id, sessionId: row.sessionId, tool: row.toolName });
          },
        },
        createToolCallingClient: createHitlWriteToolModelStub(),
      },
    });

    const turnP = platform.runSessionModelTurn({
      sessionId: subagentSessionId,
      userContent: "trigger hitl in subagent internal",
      delivery: { kind: "internal" },
    });

    await approveP;
    const result = await turnP;
    await platform.stop();

    // hitlNotifier.onQueued was still called
    assert.equal(notifierCalls.length, 1);
    assert.equal(notifierCalls[0]!.sessionId, subagentSessionId);

    // In-session HITL notice IS sent for internal delivery using parent session ID
    const hitlBodies = outboundBodies.filter((b) => b.includes("HITL") || b.includes("shoggoth hitl approve"));
    assert.ok(hitlBodies.length > 0, "internal delivery with parent session should produce in-session HITL notice");

    // The outbound message uses the parent session ID, not the subagent's
    const hitlSessionIds = outboundSessionIds.filter((_, i) =>
      outboundBodies[i]!.includes("HITL") || outboundBodies[i]!.includes("shoggoth hitl approve"));
    assert.ok(hitlSessionIds.every((id) => id === parentSessionId),
      "HITL notice should be sent using parent session ID");

    assert.ok(result.latestAssistantText.length > 0);
  });
});
