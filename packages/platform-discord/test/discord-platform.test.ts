import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../../daemon/test/helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createAgentToAgentBus, createInboundMessage } from "@shoggoth/messaging";
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
  TieredTurnQueue,
  setTurnQueue,
  setPresentationNoticeResolver,
} from "@shoggoth/daemon/lib";
import { formatErrorUserText } from "@shoggoth/daemon/lib";
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
import type { PendingActionRow } from "../src/daemon-types";
import type { DiscordMessagingRuntime } from "../src/bridge";
import { setNoticeResolver } from "../src/notices";
import { createDiscordInteractionHandler } from "../src/slash-commands";
import type { DiscordInteractionEvent } from "../src/interaction";

// Wire daemon notice resolver so platform-discord's daemonNotice() works in tests.
loadDaemonNotices();
setNoticeResolver(daemonNotice);
setPresentationNoticeResolver(daemonNotice);

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

const stubNotifyAgentTyping: DiscordMessagingRuntime["notifyAgentTypingForSession"] =
  async () => {};

const stubDiscordGatewaySession: DiscordMessagingRuntime["gateway"] = {
  stop: async () => {},
  getBotUserId: () => undefined,
};

describe("discord platform helpers", () => {
  it("formatDiscordPlatformDegradedPrefix is empty when not degraded", () => {
    const cfg = defaultConfig(tmpdir());
    assert.equal(formatDiscordPlatformDegradedPrefix(cfg, "sess1", undefined), "");
    assert.equal(
      formatDiscordPlatformDegradedPrefix(cfg, "sess1", {
        degraded: false,
        usedModel: "m1",
        usedProviderId: "p1",
      }),
      "",
    );
  });

  it("formatDiscordPlatformDegradedPrefix includes model when degraded", () => {
    const cfg = defaultConfig(tmpdir());
    const s = formatDiscordPlatformDegradedPrefix(cfg, "sess1", {
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
        toolCalls: [{ id: "t1", name: "builtin-read", argsJson: "{}" }],
      },
      { seq: 3, role: "tool", content: "{}", toolCallId: "t1" },
    ]);
    assert.equal(chat.length, 3);
    assert.equal(chat[1]!.role, "assistant");
    assert.ok(
      "toolCalls" in chat[1]! && (chat[1] as { toolCalls: unknown[] }).toolCalls.length === 1,
    );
  });
});

describe("formatErrorUserText", () => {
  it("maps ModelHttpError statuses to friendly copy", () => {
    assert.match(formatErrorUserText(new ModelHttpError(429, "x")), /rate-limited/i);
    assert.match(formatErrorUserText(new ModelHttpError(503, "x")), /unavailable/i);
    assert.match(formatErrorUserText(new ModelHttpError(500, "x")), /500/i);
    assert.match(formatErrorUserText(new ModelHttpError(401, "x")), /401/i);
    assert.match(formatErrorUserText(new ModelHttpError(418, "x")), /418/);
    assert.match(
      formatErrorUserText(new ModelHttpError(400, "Bad Request", "invalid_request: tool schema")),
      /400/i,
    );
    assert.match(
      formatErrorUserText(new ModelHttpError(400, "Bad Request", "invalid_request: tool schema")),
      /tool schema/i,
    );
  });

  it("maps fetch-like TypeError to a network hint", () => {
    assert.match(formatErrorUserText(new TypeError("fetch failed")), /Network error/i);
  });

  it("maps hitl_pending to approval copy with id, not stack", () => {
    const t = formatErrorUserText(new Error("hitl_pending:pend-uuid-1\n    at foo (bar.js:1:1)"));
    assert.match(t, /pend-uuid-1/);
    assert.match(t, /approval/i);
    assert.equal(t.includes("at foo"), false);
  });

  it("truncates generic Error to first line", () => {
    const t = formatErrorUserText(new Error("line1\nline2\nline3"));
    assert.match(t, /^line1$/);
  });
});

describe("discord-hitl-notifier", () => {
  function row(overrides: Partial<PendingActionRow>): PendingActionRow {
    return {
      id: "pend-1",
      sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      correlationId: undefined,
      toolName: "builtin-write",
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
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-discord-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({
      id: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      workspacePath: tmp,
    });
    setTurnQueue(new TieredTurnQueue());
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
      await vi.advanceTimersByTimeAsync(5);
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
                name: "builtin-write",
                arguments: JSON.stringify({
                  path: "hitl-notify.txt",
                  content: "x",
                }),
              },
            ],
            usedModel: "m1",
            usedProviderId: "p1",
          };
        }
        return {
          content: "Done",
          toolCalls: [],
          usedModel: "m1",
          usedProviderId: "p1",
        };
      },
    });
  }

  afterEach(async () => {
    vi.useRealTimers();
    await closeTestDb(db, tmp);
  });

  it("runs tool loop and sends Discord reply with degraded banner", async () => {
    const sent: { body: string }[] = [];
    const typingSessions: string[] = [];
    const bus = createAgentToAgentBus();
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
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

    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /Degraded/);
    assert.match(sent[0]!.body, /\*\*🦑 LabBot:\*\*\n/);
    assert.match(sent[0]!.body, /Hello/);
    assert.ok(typingSessions.length >= 1);
    assert.ok(typingSessions.every((s) => s === sessionUrn));
  });

  it("thread sentinel '.' exits before placeholder, typing indicator, and turn", async () => {
    const sent: { body: string }[] = [];
    const typingSessions: string[] = [];
    let streamStarts = 0;
    let modelCalls = 0;
    const bus = createAgentToAgentBus();
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000002";
    const sessions = createSessionStore(db);
    sessions.create({ id: sessionUrn, workspacePath: tmp });
    // Thread subagent session bound to a fresh thread (no transcript history yet).
    sessions.update(sessionUrn, {
      subagentMode: "persistent",
      subagentPlatformThreadId: "thread-2",
    });

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
      // Streaming enabled: start() would post the "…" placeholder message.
      streamingForSession: () => ({
        start: async () => {
          streamStarts++;
          sent.push({ body: "…" });
          return {
            setFullContent: async () => {},
            pushUpdate: async () => {},
          };
        },
      }),
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: async (sid) => {
        typingSessions.push(sid);
      },
      routes: [{ channelId: "thread-2", sessionId: sessionUrn }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      env: { SHOGGOTH_DISCORD_STREAM: "1" },
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            modelCalls++;
            return {
              content: "should not run",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
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
        body: ".",
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    // Sentinel: the thread was already started by the creation status message, so
    // the "." message must produce no placeholder, no typing, and no model turn.
    assert.equal(streamStarts, 0);
    assert.equal(sent.length, 0);
    assert.equal(typingSessions.length, 0);
    assert.equal(modelCalls, 0);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "ping",
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    assert.equal(sent.length, 1);
    // The catch-all in session-agent-turn now swallows ModelHttpError and returns
    // a partial response with the error message instead of re-throwing.
    assert.match(sent[0]!.body, /Turn failed/i);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "ping",
      }),
    );

    await vi.advanceTimersByTimeAsync(50);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
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

    createSessionStore(db).create({
      id: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      workspacePath: tmp,
    });

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
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
        {
          channelId: "c2",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        },
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 1);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 1);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 2);

    await platform.stop();
  });

  it("per-session MCP pool reconnects after perInstanceIdleTimeoutMs", async () => {
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      perInstanceIdleTimeoutMs: 40,
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 1);

    await vi.advanceTimersByTimeAsync(120);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 2);

    await platform.stop();
  });

  it("perInstanceIdleTimeoutMs 0 keeps a single per-session MCP pool across idle gaps", async () => {
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      perInstanceIdleTimeoutMs: 0,
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 1);

    await vi.advanceTimersByTimeAsync(120);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
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

    createSessionStore(db).create({
      id: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      workspacePath: tmp,
    });

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
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
        {
          channelId: "c2",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      servers: [
        {
          id: "g",
          transport: "stdio",
          command: "true",
          args: [],
          poolScope: "global",
        },
        {
          id: "p",
          transport: "stdio",
          command: "true",
          args: [],
          poolScope: "inherit",
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

    assert.equal(connectLog.length, 1);
    assert.deepStrictEqual(connectLog[0]!.ids, ["g"]);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectLog.length, 2);
    assert.deepStrictEqual(connectLog[1]!.ids, ["p"]);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectLog.length, 2);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
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

    createSessionStore(db).create({
      id: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      workspacePath: tmp,
    });

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
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
        {
          channelId: "c2",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        },
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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "a",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 2);
    assert.deepEqual(
      connectArgs[1]!.map((s) => s.id),
      ["sandbox"],
    );

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d2",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "b",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(connectCalls, 2);

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
      createInboundMessage({
        id: "d3",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000002",
        createdAt: new Date().toISOString(),
        body: "c",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const cfg = defaultConfig(tmp);
    cfg.mcp = {
      poolScope: "per_session",
      servers: [
        {
          id: "shared_index",
          transport: "stdio",
          command: "true",
          args: [],
          poolScope: "global",
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
    assert.deepEqual(
      connectArgs[0]!.map((s) => s.id),
      ["shared_index"],
    );

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d1",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "hi",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const approveP = approveFirstPendingWhenQueued(
      hitlStack,
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
    );

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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-ch",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl",
      }),
    );

    await approveP;
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    const opMsgs = createMessageCalls.filter((c) => c.channelId === notifyChannelId);
    assert.equal(opMsgs.length, 1);
    assert.match(opMsgs[0]!.content, /HITL/);
    assert.match(opMsgs[0]!.content, /builtin-write/);
    assert.match(opMsgs[0]!.content, /shoggoth hitl approve/);
    assert.match(
      opMsgs[0]!.content,
      /agent:test:discord:channel:10000000-0000-4000-8000-000000000001/,
    );
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const targetDmUser = "347033761822801922";
    const approveP = approveFirstPendingWhenQueued(
      hitlStack,
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
    );

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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-dm",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl dm",
      }),
    );

    await approveP;
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    assert.deepEqual(dmOpens, [targetDmUser]);
    const dmMsgs = createMessageCalls.filter((c) => c.channelId === "dm-ch-from-api");
    assert.equal(dmMsgs.length, 1);
    assert.match(dmMsgs[0]!.content, /HITL/);
    assert.match(dmMsgs[0]!.content, /builtin-write/);
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
        routes: [
          {
            channelId: "c1",
            sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          },
        ],
      };

      const approveP = approveFirstPendingWhenQueued(
        hitlStack,
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      );

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
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-wh",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "trigger hitl webhook",
        }),
      );

      await approveP;
      await vi.advanceTimersByTimeAsync(50);
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
      assert.equal(
        parsed.sessionId,
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      );
      assert.equal(parsed.tool, "builtin-write");
      assert.equal(parsed.riskTier, "caution");
      assert.ok(typeof parsed.pendingId === "string" && parsed.pendingId.length > 0);
      assert.ok(
        typeof parsed.payloadPreview === "string" && parsed.payloadPreview.includes("hitl-notify"),
      );
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
        routes: [
          {
            channelId: "c1",
            sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          },
        ],
      };

      const approveP = approveFirstPendingWhenQueued(
        hitlStack,
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      );

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
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-both",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "trigger both",
        }),
      );

      await approveP;
      await vi.advanceTimersByTimeAsync(50);
      await platform.stop();

      assert.ok(fetchCalls.some((c) => c.url === webhookUrl));
      assert.equal(createMessageCalls.filter((c) => c.channelId === notifyChannelId).length, 1);
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
        routes: [
          {
            channelId: "c1",
            sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          },
        ],
      };

      const approveP = approveFirstPendingWhenQueued(
        hitlStack,
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      );

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
        "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createInboundMessage({
          id: "d-hitl-none",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
          createdAt: new Date().toISOString(),
          body: "hitl no notify",
        }),
      );

      await approveP;
      await vi.advanceTimersByTimeAsync(50);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const approveP = approveFirstPendingWhenQueued(
      hitlStack,
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
    );

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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-in-thread",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl in thread",
      }),
    );

    await approveP;
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    const hitlBodies = outboundBodies.filter(
      (b) => b.includes("HITL") && b.includes("shoggoth hitl approve"),
    );
    assert.ok(hitlBodies.length >= 1, "expected at least one outbound HITL notice");
    assert.match(hitlBodies[0]!, /builtin-write/);
    assert.match(hitlBodies[0]!, /agent:test:discord:channel:10000000-0000-4000-8000-000000000001/);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const approveP = approveFirstPendingWhenQueued(
      hitlStack,
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
    );

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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-no-in-thread",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl no in-thread",
      }),
    );

    await approveP;
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    const hitlBodies = outboundBodies.filter(
      (b) => b.includes("HITL") && b.includes("shoggoth hitl approve"),
    );
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const approveP = approveFirstPendingWhenQueued(
      hitlStack,
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
    );
    const cfg = {
      ...defaultConfig(tmp),
      platforms: {
        discord: { enabled: true, hitlReplyInSession: false as const },
      },
    };

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
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-hitl-config-off",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        body: "trigger hitl config off",
      }),
    );

    await approveP;
    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    const hitlBodies = outboundBodies.filter(
      (b) => b.includes("HITL") && b.includes("shoggoth hitl approve"),
    );
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const ownerId = "111111111111111111";
    const cfg = {
      ...defaultConfig(tmp),
      platforms: { discord: { enabled: true, ownerUserId: ownerId } },
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "nope",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-nonowner",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
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

    await vi.advanceTimersByTimeAsync(50);
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
      routes: [
        {
          channelId: "c1",
          sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const ownerId = "111111111111111111";
    const cfg = {
      ...defaultConfig(tmp),
      platforms: { discord: { enabled: true, ownerUserId: ownerId } },
    };

    const platform = await startDiscordPlatform({
      db,
      config: cfg,
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "owner reply",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    bus.deliver(
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
      createInboundMessage({
        id: "d-owner",
        sessionId: "agent:test:discord:channel:10000000-0000-4000-8000-000000000001",
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

    await vi.advanceTimersByTimeAsync(50);
    await platform.stop();

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /owner reply/);
  });

  it("subagent runSessionModelTurn with messaging_surface delivery fires afterHitlQueued and hitlNotifier", async () => {
    const parentSessionId = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    const subagentSessionId =
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000001:bbbbbbbb-bbbb-4ccc-dddd-eeeeeeeeeeee";
    createSessionStore(db).create({
      id: subagentSessionId,
      workspacePath: tmp,
    });
    createSessionStore(db).update(subagentSessionId, {
      parentSessionId,
      subagentMode: "one_shot",
    });

    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const notifierCalls: {
      pendingId: string;
      sessionId: string;
      tool: string;
    }[] = [];
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
            notifierCalls.push({
              pendingId: row.id,
              sessionId: row.sessionId,
              tool: row.toolName,
            });
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
    assert.equal(notifierCalls[0]!.tool, "builtin-write");

    // afterHitlQueued fired: in-session HITL notice was sent via outbound
    const hitlBodies = outboundBodies.filter(
      (b) => b.includes("HITL") && b.includes("shoggoth hitl approve"),
    );
    assert.ok(hitlBodies.length >= 1, "expected at least one in-session HITL notice for subagent");
    assert.match(hitlBodies[0]!, /builtin-write/);
    assert.match(
      hitlBodies[0]!,
      new RegExp(subagentSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    // The turn completed with a reply
    assert.ok(result.latestAssistantText.length > 0);
  });

  it("subagent runSessionModelTurn with internal delivery fires afterHitlQueued using parent session channel", async () => {
    const parentSessionId = "agent:test:discord:channel:10000000-0000-4000-8000-000000000099";
    const subagentSessionId =
      "agent:test:discord:channel:10000000-0000-4000-8000-000000000099:cccccccc-cccc-4ccc-dddd-eeeeeeeeeeee";
    createSessionStore(db).create({ id: parentSessionId, workspacePath: tmp });
    createSessionStore(db).create({
      id: subagentSessionId,
      workspacePath: tmp,
    });
    createSessionStore(db).update(subagentSessionId, {
      parentSessionId,
      subagentMode: "one_shot",
    });

    const hitlStack = createHitlPendingResolutionStack(db);
    const outboundBodies: string[] = [];
    const outboundSessionIds: string[] = [];
    const notifierCalls: {
      pendingId: string;
      sessionId: string;
      tool: string;
    }[] = [];
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
      resolveOutboundChannelIdForSession: (sid) => (sid === parentSessionId ? "c1" : undefined),
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
            notifierCalls.push({
              pendingId: row.id,
              sessionId: row.sessionId,
              tool: row.toolName,
            });
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
    const hitlBodies = outboundBodies.filter(
      (b) => b.includes("HITL") || b.includes("shoggoth hitl approve"),
    );
    assert.ok(
      hitlBodies.length > 0,
      "internal delivery with parent session should produce in-session HITL notice",
    );

    // The outbound message uses the parent session ID, not the subagent's
    const hitlSessionIds = outboundSessionIds.filter(
      (_, i) =>
        outboundBodies[i]!.includes("HITL") || outboundBodies[i]!.includes("shoggoth hitl approve"),
    );
    assert.ok(
      hitlSessionIds.every((id) => id === parentSessionId),
      "HITL notice should be sent using parent session ID",
    );

    assert.ok(result.latestAssistantText.length > 0);
  });

  it("canned prompt delivers the assistant reply exactly once (platform post + ack-then-edit interaction flow)", async () => {
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    const marker = "unique-reply-marker";

    // Channel-visible posts captured from both delivery surfaces.
    const sent: { body: string }[] = [];
    const interactionResponses: Array<{
      type: number;
      data?: { content?: string; components?: readonly unknown[] };
    }> = [];
    const interactionEdits: Array<{ content: string }> = [];
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          sent.push({ body: m.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: sessionUrn }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: marker,
              toolCalls: [],
              usedProviderId: "p1",
              usedModel: "m1",
            };
          },
        }),
      },
    });

    // Mirrors the daemon prompt op: runs the turn (delivered via the
    // messaging_surface path) and returns the rendered reply in the result.
    const handler = createDiscordInteractionHandler({
      transport: {
        interactionCallback: async (_id, _token, body) => {
          interactionResponses.push(body);
        },
        editOriginalInteractionResponse: async (_appId, _token, body) => {
          interactionEdits.push(body);
        },
      },
      applicationId: "app-123",
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      abortSession: async () => false,
      invokeControlOp: async (op, payload) => {
        if (op !== "prompt") return { ok: false, error: `unexpected op ${op}` };
        await platform.runSessionModelTurn({
          sessionId: String(payload.session_id),
          userContent: "canned prompt run",
          delivery: {
            kind: "messaging_surface",
            userId: "u-1",
            replyToMessageId: undefined,
          },
        });
        return { ok: true, result: { reply: marker } };
      },
      resolveSessionForChannel: () => sessionUrn,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-9",
      token: "tok-9",
      type: 5,
      channelId: "c1",
      userId: "u-1",
      data: {
        custom_id: `prompt_modal|${sessionUrn}|triage`,
        components: [{ type: 1, components: [{ type: 4, custom_id: "cardId", value: "F-1" }] }],
      },
    };

    handler(ev);
    // The ack lands BEFORE the turn starts, so keep advancing timers until the
    // post-turn edit has been delivered too — otherwise platform.stop() could
    // tear things down between the ack and the outcome edit.
    for (
      let i = 0;
      i < 200 && (interactionResponses.length === 0 || interactionEdits.length === 0);
      i++
    ) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await platform.stop();

    // The platform path posts the full reply exactly once…
    const replyPosts = sent.filter((s) => s.body.includes(marker));
    assert.strictEqual(
      replyPosts.length,
      1,
      "assistant reply should be posted exactly once by the platform path",
    );

    // …and the modal submit is ACKed up front with one UPDATE_MESSAGE (7)
    // carrying the pending state — never the reply text.
    assert.strictEqual(interactionResponses.length, 1, "modal submit ACKs exactly once");
    const resp = interactionResponses[0]!;
    assert.strictEqual(resp.type, 7, "modal submit should update message A in place");
    assert.ok(
      resp.data?.content?.includes("⏳ Running"),
      "interaction response should carry the pending-state ack",
    );
    assert.ok(
      !resp.data?.content?.includes(marker),
      "interaction response must not repeat the assistant reply",
    );
    assert.deepStrictEqual(resp.data?.components, [], "dropdown must be cleared");

    // The outcome then lands as a single edit of that response (the ack
    // already rewrote message A, so the edit updates it in place rather than
    // leaving it stale) — still never repeating the reply text.
    assert.strictEqual(interactionEdits.length, 1, "outcome is delivered via one edit");
    const edit = interactionEdits[0]!;
    assert.ok(edit.content.includes("✅ Prompt"), "edit should carry the prompt ack");
    assert.ok(!edit.content.includes(marker), "edit must not repeat the assistant reply");
  });

  it("canned prompt with streaming enabled streams the reply instead of posting it at once", async () => {
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    const marker = "streamed-reply-marker";

    // At-once outbound posts vs streaming message edits, in call order.
    const sent: { body: string }[] = [];
    const events: string[] = [];
    const streamPushes: string[] = [];
    let finalBody: string | undefined;
    const bus = createAgentToAgentBus();
    const discord: DiscordMessagingRuntime = {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          sent.push({ body: m.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => ({
        start: async () => {
          events.push("stream-start");
          return {
            setFullContent: async (text: string) => {
              events.push("stream-finalize");
              finalBody = text;
            },
            pushUpdate: async (text: string) => {
              events.push("stream-push");
              streamPushes.push(text);
            },
          };
        },
      }),
      bus,
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: async () => {
        events.push("typing");
      },
      routes: [{ channelId: "c1", sessionId: sessionUrn }],
    };

    const platform = await startDiscordPlatform({
      db,
      config: defaultConfig(tmp),
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord,
      env: { SHOGGOTH_DISCORD_STREAM: "1" },
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools(input: {
            onTextDelta?: (delta: string, accumulated: string) => void;
          }) {
            events.push("model-call");
            input.onTextDelta?.("streamed ", "streamed ");
            input.onTextDelta?.("reply", marker);
            return {
              content: marker,
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    // Mirrors the daemon prompt op: the canned prompt turn runs through the
    // messaging_surface delivery path.
    const result = await platform.runSessionModelTurn({
      sessionId: sessionUrn,
      userContent: "canned prompt run",
      delivery: { kind: "messaging_surface", userId: "u-1", replyToMessageId: undefined },
    });
    await platform.stop();

    assert.ok(result.latestAssistantText.includes(marker));

    // The stream handle (placeholder message) is started before the typing
    // indicator and before the turn runs…
    assert.ok(
      events.indexOf("stream-start") >= 0 &&
        events.indexOf("stream-start") < events.indexOf("typing"),
      "stream placeholder must be posted before the typing indicator",
    );
    assert.ok(events.indexOf("stream-start") < events.indexOf("model-call"));

    // …model deltas were pushed as live stream edits…
    assert.ok(
      streamPushes.some((p) => p.includes(marker)),
      "model text deltas should reach the stream handle as live updates",
    );

    // …and the stream was finalized with the formatted reply.
    assert.ok(
      finalBody?.includes(marker),
      "stream should be finalized with the full formatted reply",
    );

    // The reply must NOT also be posted at once via the outbound surface.
    assert.strictEqual(
      sent.filter((s) => s.body.includes(marker)).length,
      0,
      "streamed reply must not be double-posted",
    );
  });
});

describe("platform status bar dep wiring", { concurrency: false }, () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "shoggoth-discord-status-"));
    const dbPath = join(tmp, "s.db");
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, defaultMigrationsDir());
    setTurnQueue(new TieredTurnQueue());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeTestDb(db, tmp);
  });

  /** Seed session_stats for the session: sequence from turn_count, compactions from compaction_count,
   *  context from the latest per-call input_tokens (input_tokens column). */
  function seedStats(
    sessionUrn: string,
    overrides: Partial<{
      turn_count: number;
      compaction_count: number;
      input_tokens: number;
      context_window_tokens: number;
    }> = {},
  ) {
    db.prepare(
      `INSERT INTO session_stats (session_id, turn_count, compaction_count, input_tokens, output_tokens, context_window_tokens, updated_at)
       VALUES (@sid, @tc, @cc, @it, 0, @cwt, datetime('now'))`,
    ).run({
      sid: sessionUrn,
      tc: overrides.turn_count ?? 7,
      cc: overrides.compaction_count ?? 2,
      it: overrides.input_tokens ?? 31_421,
      cwt: overrides.context_window_tokens ?? 100_000,
    });
  }

  function baseRuntime(sessionUrn: string, capture: { body: string }[]): DiscordMessagingRuntime {
    return {
      stop: async () => {},
      gateway: stubDiscordGatewaySession,
      discordBotUserId: undefined,
      outbound: {
        sendDiscord: async (m) => {
          capture.push({ body: m.body });
          return { channelId: "c", messageId: "mid" };
        },
      },
      discordRestTransport: stubDiscordRestTransport,
      streamingForSession: () => undefined,
      bus: createAgentToAgentBus(),
      capabilities: discordCapabilityDescriptor(),
      registerPlatformThreadBinding: () => () => {},
      notifyAgentTypingForSession: stubNotifyAgentTyping,
      routes: [{ channelId: "c1", sessionId: sessionUrn }],
    };
  }

  it("builds the statusBar dep {config from resolveStatusBarConfig, render from renderDiscordStatusBar, attachSink} and passes it to the presentation orchestrator when status is enabled", async () => {
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    createSessionStore(db).create({ id: sessionUrn, workspacePath: tmp });

    // The orchestrator wraps pre-started stream handles with attachSink only when
    // streaming is enabled. To observe the dep end-to-end we enable streaming so
    // the platform builds a stream handle; the orchestrator then calls the dep's
    // attachSink. The stub attachSink is a no-op, so the returned handle never
    // gains setStatusBar — asserting on that proves the sink was NOT attached.
    const capture: { body: string }[] = [];
    const streamHandles: Array<{
      setFullContent(text: string): Promise<void>;
      pushUpdate(text: string): Promise<void>;
      setStatusBar?: (line: string | null) => Promise<void>;
    }> = [];
    const runtime: DiscordMessagingRuntime = {
      ...baseRuntime(sessionUrn, capture),
      streamingForSession: () => ({
        start: async () => {
          const handle = {
            setFullContent: async () => {},
            pushUpdate: async () => {},
          };
          streamHandles.push(handle);
          return handle;
        },
      }),
    };

    const platform = await startDiscordPlatform({
      db,
      config: {
        ...defaultConfig(tmp),
        platforms: { statusBar: { enabled: true } },
      },
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord: runtime,
      env: { SHOGGOTH_DISCORD_STREAM: "1" },
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "wired",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    await platform.runSessionModelTurn({
      sessionId: sessionUrn,
      userContent: "hi",
      delivery: { kind: "messaging_surface", userId: "u-1" },
    });
    await platform.stop();

    // The platform builds a status bar dep and the orchestrator wraps the pre-started
    // stream handle via attachSink, returning a handle that can carry setStatusBar.
    // With the minimal no-op stub the handle never gains setStatusBar, so this FAILS
    // until the real attachSink is wired (GREEN task).
    assert.ok(
      streamHandles.length > 0,
      "streaming should start a stream handle for the messaging_surface path",
    );
    assert.ok(
      streamHandles.every((h) => typeof h.setStatusBar === "function"),
      "the orchestrator must attach the status-bar sink so the stream handle carries setStatusBar",
    );
  });

  it("runSessionModelTurn messaging_surface: tracker wraps the stream pusher and the terminal bar lands on the final setFullContent", async () => {
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    createSessionStore(db).create({ id: sessionUrn, workspacePath: tmp });
    seedStats(sessionUrn, {
      turn_count: 7,
      compaction_count: 2,
      input_tokens: 31_421,
      context_window_tokens: 100_000,
    });

    const capture: { body: string }[] = [];
    let finalBody: string | undefined;
    const barLines: Array<string | null> = [];
    const runtime: DiscordMessagingRuntime = {
      ...baseRuntime(sessionUrn, capture),
      streamingForSession: () => ({
        start: async () => ({
          setFullContent: async (text: string) => {
            finalBody = text;
          },
          pushUpdate: async () => {},
          setStatusBar: async (line: string | null) => {
            barLines.push(line);
          },
        }),
      }),
    };

    const platform = await startDiscordPlatform({
      db,
      config: {
        ...defaultConfig(tmp),
        platforms: { statusBar: { enabled: true } },
      },
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord: runtime,
      env: { SHOGGOTH_DISCORD_STREAM: "1" },
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "streamed reply",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    await platform.runSessionModelTurn({
      sessionId: sessionUrn,
      userContent: "hi",
      delivery: { kind: "messaging_surface", userId: "u-1" },
    });
    await platform.stop();

    // The terminal bar (✅ ｜ 🔢 `7` ｜ 🗑️ `2` ｜ 🪟 ...) must land on the final
    // stream delivery. The tracker renders it and passes it through the sink that
    // wraps the stream pusher; with the no-op attachSink the handle never receives
    // the bar, so this FAILS until the real sink applies the line.
    const terminalLine = barLines.at(-1);
    assert.ok(
      terminalLine !== undefined,
      "the terminal bar must be applied to the in-flight stream message",
    );
    assert.ok(terminalLine!.includes("✅"), "terminal bar must render the ✅ finished phase");
    assert.ok(
      terminalLine!.includes("`7`"),
      `terminal bar must carry sequence 7 from session_stats.turn_count, got: ${terminalLine}`,
    );
    assert.ok(
      terminalLine!.includes("`2`"),
      `terminal bar must carry compactions 2 from session_stats.compaction_count, got: ${terminalLine}`,
    );
    assert.ok(
      terminalLine!.includes("31.4%/100K"),
      `terminal bar must carry the latest per-call input tokens as context, got: ${terminalLine}`,
    );

    // The body that lands on the final setFullContent is the formatted reply; with the
    // real sink the bar is appended to it (body ends with the bar).
    assert.ok(finalBody !== undefined, "final setFullContent must be called");
  });

  it("runSessionModelTurn messaging_surface at-once: terminal bar lands on the final sendBody", async () => {
    const sessionUrn = "agent:test:discord:channel:10000000-0000-4000-8000-000000000001";
    createSessionStore(db).create({ id: sessionUrn, workspacePath: tmp });
    seedStats(sessionUrn, {
      turn_count: 7,
      compaction_count: 2,
      input_tokens: 31_421,
      context_window_tokens: 100_000,
    });

    const capture: { body: string }[] = [];
    const platform = await startDiscordPlatform({
      db,
      config: {
        ...defaultConfig(tmp),
        platforms: { statusBar: { enabled: true } },
      },
      logger: createLogger({ component: "t", minLevel: "error" }),
      discord: baseRuntime(sessionUrn, capture),
      deps: {
        createToolCallingClient: () => ({
          async completeWithTools() {
            return {
              content: "plain reply",
              toolCalls: [],
              usedModel: "m1",
              usedProviderId: "p1",
            };
          },
        }),
      },
    });

    await platform.runSessionModelTurn({
      sessionId: sessionUrn,
      userContent: "hi",
      delivery: { kind: "messaging_surface", userId: "u-1" },
    });
    await platform.stop();

    // At-once path: the final sendBody must carry the terminal bar appended.
    assert.ok(
      capture.length > 0,
      "the messaging_surface at-once path must deliver the reply via sendBody",
    );
    const last = capture[capture.length - 1]!.body;
    assert.ok(last.includes("✅"), `final sendBody must carry the terminal ✅ bar, got: ${last}`);
    assert.ok(
      last.includes("`7`"),
      `final sendBody must carry sequence 7 from session_stats.turn_count, got: ${last}`,
    );
    assert.ok(
      last.includes("`2`"),
      `final sendBody must carry compactions 2 from session_stats.compaction_count, got: ${last}`,
    );
    assert.ok(
      last.includes("31.4%/100K"),
      `final sendBody must carry the latest per-call input tokens as context, got: ${last}`,
    );
  });
});
