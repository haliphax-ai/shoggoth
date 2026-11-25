import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Reaction passthrough session resolution, wired inside plugin.ts's
 * `platform.start` hook. Regression coverage for the
 * `reaction.passthrough.no_session` drop: reactions on dynamically-bound
 * threads must resolve their session via the messaging runtime's
 * `resolveSessionId` (dynamic bindings first, static routes second). The
 * messaging bootstrap and platform handle are mocked; the reaction event is
 * delivered through the captured gateway handler.
 */

const h = vi.hoisted(() => ({
  captured: {
    onReactionAdd: undefined as ((ev: unknown) => void) | undefined,
    messagingOpts: undefined as Record<string, any> | undefined,
    runtime: undefined as Record<string, any> | undefined,
    platformOpts: undefined as any,
    bindings: undefined as Map<string, string> | undefined,
    platformHandle: undefined as Record<string, any> | undefined,
  },
}));

vi.mock("../src/bootstrap", () => ({
  startDaemonDiscordMessaging: vi.fn(async (opts: Record<string, any>) => {
    h.captured.onReactionAdd = opts.onMessageReactionAdd;
    h.captured.messagingOpts = opts;
    if (opts.reactionBotUserIdRef) opts.reactionBotUserIdRef.current = "bot-99";
    // Mirrors the bridge: routes are parsed inside bootstrap and closed over
    // by resolveSessionId — the plugin never passes them in.
    const routes = [
      {
        channelId: "1500000000000000001",
        sessionId: "agent:dev:discord:channel:1500000000000000001",
        guildId: "guild-1",
      },
    ];
    const runtime: Record<string, any> = {
      routes,
      capabilities: { extensions: {} },
      discordBotUserId: "bot-99",
      discordRestTransport: {
        createMessage: vi.fn(async () => ({})),
        createMessageWithFiles: vi.fn(async () => ({})),
        editMessage: vi.fn(async () => ({})),
        createThread: vi.fn(async () => ({})),
        getMessage: vi.fn(async () => ({
          id: "m-1",
          content: "agent reply under reaction",
          timestamp: "2026-10-13T14:00:00.000Z",
          author: { id: "bot-99" },
        })),
      },
      registerPlatformThreadBinding: vi.fn(() => () => {}),
      resolveOutboundChannelIdForSession: vi.fn(() => undefined),
      resolveGuildIdForSession: vi.fn(() => "guild-1"),
      // Mirrors the bridge contract: dynamic bindings first, then static routes.
      resolveSessionId: vi.fn((channelId: string, guildId?: string) => {
        const bound = h.captured.bindings?.get(channelId);
        if (bound) return bound;
        for (const r of routes) {
          if (r.channelId !== channelId) continue;
          if (r.guildId !== undefined && r.guildId !== guildId) continue;
          if (r.guildId === undefined && guildId !== undefined) continue;
          return r.sessionId;
        }
        return undefined;
      }),
      stop: vi.fn(async () => {}),
    };
    h.captured.runtime = runtime;
    return runtime;
  }),
}));

vi.mock("../src/platform", () => ({
  startDiscordPlatform: vi.fn((opts: Record<string, any>) => {
    h.captured.platformOpts = opts;
    const handle = {
      runSessionModelTurn: vi.fn(async () => {}),
      subscribeSubagentSession: vi.fn(() => () => {}),
      announcePersistentSubagentSessionEnded: vi.fn(async () => {}),
      handleReactionPassthrough: vi.fn(async () => {}),
      pinMessage: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      adapter: { sendBody: vi.fn(async () => {}) },
    };
    h.captured.platformHandle = handle;
    return handle;
  }),
}));

import createDiscordPlugin from "../src/plugin";
import type { HitlDiscordNoticeRegistry } from "../src/hitl/notice-registry";

const OWNER = "owner-1";
const TEST_CONFIG = {
  platforms: { discord: { ownerUserId: OWNER } },
} as any;

let passthrough: ReturnType<typeof createDiscordPlugin>;
let ctx: Record<string, any>;
let deps: Record<string, any>;
let handleReactionPassthrough: ReturnType<typeof vi.fn>;

function reactionEvent(channelId: string) {
  return {
    kind: "message_reaction_add",
    userId: OWNER,
    channelId,
    messageId: "m-1",
    guildId: "guild-1",
    emoji: { id: null, name: "\u{1F44D}" },
  };
}

async function deliver(ev: unknown) {
  h.captured.onReactionAdd?.(ev);
  await vi.waitFor(() => expect(handleReactionPassthrough).toHaveBeenCalled());
}

function platformHandleSpy(): ReturnType<typeof vi.fn> {
  return h.captured.platformHandle?.handleReactionPassthrough as ReturnType<typeof vi.fn>;
}

beforeEach(async () => {
  h.captured.onReactionAdd = undefined;
  h.captured.messagingOpts = undefined;
  h.captured.platformOpts = undefined;
  h.captured.bindings = new Map<string, string>();
  h.captured.platformHandle = undefined;
  vi.clearAllMocks();
  delete process.env.SHOGGOTH_DISCORD_OWNER_USER_ID;

  passthrough = createDiscordPlugin();

  deps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    policyEngine: {},
    hitlStack: {
      pending: {
        approve: vi.fn(),
        deny: vi.fn(),
        listPendingForSession: vi.fn(() => []),
        listAllPending: vi.fn(() => []),
      },
      waitForHitlResolution: vi.fn(async () => "approved" as const),
    },
    hitlAutoApproveGate: {
      enableSessionTool: vi.fn(),
      enableAgentTool: vi.fn(async () => {}),
      shouldAutoApprove: vi.fn(() => false),
    },
    hitlConfigRef: undefined,
    abortSession: vi.fn(),
    invokeControlOp: vi.fn(),
    registerPlatform: vi.fn(),
    stopAllPlatforms: vi.fn(async () => {}),
    reconcilePersistentSubagents: vi.fn(() => ({ restored: 0, expiredKilled: 0 })),
    noticeResolver: (key: string) => `notice:${key}`,
    platformAssistantDeps: undefined,
  };
  ctx = {
    db: { prepare: () => ({ get: () => undefined }) },
    config: undefined,
    configRef: { current: TEST_CONFIG },
    env: undefined,
    deps,
    deliveryRegistry: { register: vi.fn(), resolveOperatorDelivery: vi.fn() },
    registerDrain: vi.fn(),
    setSubagentRuntimeExtension: vi.fn(),
    setMessageToolContext: vi.fn(),
    setPlatformAdapter: vi.fn(),
  };

  await passthrough.hooks["platform.start"](ctx as any);
  // Notice resolver from PlatformDeps flows into the platform options (DI, not a global).
  expect(h.captured.platformOpts?.noticeResolver).toBe(deps.noticeResolver);
  handleReactionPassthrough = platformHandleSpy();
});

describe("reaction passthrough registry fast path", () => {
  /** The plugin creates its own registry at start; grab it via captured platform opts. */
  function registry(): HitlDiscordNoticeRegistry {
    return (h.captured.platformOpts as Record<string, any>).hitlDiscordNoticeRegistry;
  }

  function transport(): Record<string, any> {
    return h.captured.runtime?.discordRestTransport as Record<string, any>;
  }

  it("skips the REST author GET for a registered HITL notice", async () => {
    registry().register("1500000000000000001", "m-1", "pending-1", "agent:test:s1", "shell");

    await deliver(reactionEvent("1500000000000000001"));

    expect(transport().getMessage).not.toHaveBeenCalled();
    expect(handleReactionPassthrough).toHaveBeenCalledTimes(1);
  });

  it("falls back to the REST author GET on a registry miss", async () => {
    registry().register(
      "1500000000000000001",
      "registered-id",
      "pending-1",
      "agent:test:s1",
      "shell",
    );

    await deliver(reactionEvent("1500000000000000001"));

    expect(transport().getMessage).toHaveBeenCalledTimes(1);
    expect(handleReactionPassthrough).toHaveBeenCalledTimes(1);
  });

  it("drops owner reactions on non-bot messages (author check preserved)", async () => {
    registry().register(
      "1500000000000000001",
      "registered-id",
      "pending-1",
      "agent:test:s1",
      "shell",
    );

    transport().getMessage = vi.fn(async () => ({
      id: "m-1",
      content: "not from the bot",
      timestamp: "2026-10-13T14:00:00.000Z",
      author: { id: "human-1" },
    }));

    h.captured.onReactionAdd?.(reactionEvent("1500000000000000001"));
    await new Promise((r) => setTimeout(r, 10));

    expect(transport().getMessage).toHaveBeenCalledTimes(1);
    expect(handleReactionPassthrough).not.toHaveBeenCalled();
  });

  it("uses empty content and a fresh timestamp on the registry fast path", async () => {
    registry().register("1500000000000000001", "m-1", "pending-1", "agent:test:s1", "shell");

    await deliver(reactionEvent("1500000000000000001"));

    const call = handleReactionPassthrough.mock.calls[0][0];
    expect(call.messageContent).toBe("");
    expect(call.messageTimestamp).toBeGreaterThan(0);
    expect(call.emoji).toBe("👍");
    expect(call.userId).toBe(OWNER);
  });

  it("routes every reaction through the author GET without a HITL stack", async () => {
    // Shared setup above started the plugin WITH a HITL stack; run a separate
    // plugin instance with the stack absent to cover the plain passthrough wiring.
    h.captured.onReactionAdd = undefined;
    h.captured.messagingOpts = undefined;
    h.captured.platformOpts = undefined;
    h.captured.platformHandle = undefined;
    deps.hitlStack = undefined;
    deps.hitlAutoApproveGate = undefined;
    const plugin = createDiscordPlugin();
    await plugin.hooks["platform.start"](ctx as any);

    handleReactionPassthrough = platformHandleSpy();
    await deliver(reactionEvent("1500000000000000001"));

    expect(h.captured.platformOpts?.hitlDiscordNoticeRegistry).toBeUndefined();
    expect(transport().getMessage).toHaveBeenCalledTimes(1);
    expect(handleReactionPassthrough).toHaveBeenCalledTimes(1);
  });
});

describe("reaction passthrough session resolution", () => {
  it("delivers to a thread-bound subagent session via dynamic binding", async () => {
    const threadChannelId = "1559399196224655520";
    const boundSession = "agent:dev:discord:channel:1480957862858719232:sub-uuid";
    h.captured.bindings?.set(threadChannelId, boundSession);

    await deliver(reactionEvent(threadChannelId));

    expect(handleReactionPassthrough).toHaveBeenCalledTimes(1);
    expect(handleReactionPassthrough.mock.calls[0][0].sessionId).toBe(boundSession);
  });

  it("delivers to a statically-routed session (guild-aware)", async () => {
    await deliver(reactionEvent("1500000000000000001"));

    expect(handleReactionPassthrough).toHaveBeenCalledTimes(1);
    expect(handleReactionPassthrough.mock.calls[0][0].sessionId).toBe(
      "agent:dev:discord:channel:1500000000000000001",
    );
  });

  it("drops reactions from anyone other than the configured owner", async () => {
    const ev = { ...reactionEvent("1500000000000000001"), userId: "someone-else" };
    h.captured.onReactionAdd?.(ev);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleReactionPassthrough).not.toHaveBeenCalled();
  });
});
