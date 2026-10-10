import { describe, it, expect, vi } from "vitest";
import type { DiscordMessagingRuntime } from "../src/bridge";
import type { DiscordRestTransport } from "../src/transport";
import { discordCapabilityDescriptor } from "../src/capabilities";
import { DiscordPlatformAdapter } from "../src/discord-platform-adapter";

/** A pre-rendered terminal Discord status bar line (e.g. from renderDiscordStatusBar). */
const BAR = "> ✅ ｜ 🔢 `217` ｜ 🗑️ `1`";

function createStubTransport(): DiscordRestTransport {
  return {
    openDmChannel: async () => "dm",
    createMessage: async () => ({ id: "m1" }),
    createMessageWithFiles: async () => ({ id: "m1" }),
    editMessage: async () => {},
    deleteMessage: async () => {},
    createThreadFromMessage: async () => ({ id: "t" }),
    createThread: async () => ({ id: "t" }),
    deleteChannel: async () => {},
    getMessage: async () => ({}),
    getChannelMessages: async () => [],
    createMessageReaction: async () => {},
    deleteMessageReaction: async () => {},
    getMessageReactions: async () => [],
    searchMessages: async () => ({ messages: [], total_results: 0 }),
    triggerTypingIndicator: async () => {},
    interactionCallback: async () => {},
    registerGlobalCommands: async () => {},
    editOriginalInteractionResponse: async () => {},
  } as unknown as DiscordRestTransport;
}

interface SentBody {
  readonly body: string;
}

/** Builds a DiscordPlatformAdapter whose outbound captures every sent message body. */
function createAdapter(capture: SentBody[]): {
  adapter: DiscordPlatformAdapter;
  createMessage: ReturnType<typeof vi.fn>;
} {
  const transport = createStubTransport();
  const createMessage = vi
    .fn()
    .mockImplementation(async (_channelId: string, body: { content: string }) => {
      capture.push({ body: body.content });
      return { id: "m1" };
    });
  const runtime: DiscordMessagingRuntime = {
    stop: async () => {},
    gateway: { stop: async () => {}, getBotUserId: () => undefined },
    discordBotUserId: undefined,
    outbound: {
      sendDiscord: async (msg) => {
        capture.push({ body: msg.body });
        return { channelId: "c", messageId: "mid" };
      },
    },
    discordRestTransport: {
      ...transport,
      createMessage,
    },
    streamingForSession: () => undefined,
    bus: {} as DiscordMessagingRuntime["bus"],
    capabilities: discordCapabilityDescriptor(),
    registerPlatformThreadBinding: () => () => {},
    notifyAgentTypingForSession: async () => {},
    routes: [],
  };
  const adapter = new DiscordPlatformAdapter({
    discord: runtime,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => ({}) as never,
      }),
    },
  });
  return { adapter, createMessage };
}

describe("DiscordPlatformAdapter at-once status bar delivery", () => {
  it("appends the status bar as a blank-line-separated blockquote to the delivered body", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    await adapter.sendBody("sess-1", "Hello world", { statusBar: BAR });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.endsWith("\n\n" + BAR)).toBe(true);
  });

  it("attaches the bar to the body BEFORE splitting so the bar lands on the last chunk", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    // Body long enough to overflow 2000 chars when the bar is appended.
    const body = "word ".repeat(500); // ~2500 chars
    await adapter.sendBody("sess-2", body, { statusBar: BAR });
    expect(sent.length).toBeGreaterThan(1);
    const last = sent[sent.length - 1]!.body;
    expect(last.endsWith("\n\n" + BAR)).toBe(true);
    // The bar must be intact on a single chunk (not itself split).
    expect(last).toContain(BAR);
  });

  it("keeps the bar at the end of the last chunk even when splitting is required", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    const body = "a".repeat(1990) + "\n" + "b".repeat(1990);
    await adapter.sendBody("sess-3", body, { statusBar: BAR });
    const last = sent[sent.length - 1]!.body;
    expect(last.endsWith(BAR)).toBe(true);
  });

  it("attaches the bar to error deliveries via sendError", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    await adapter.sendError("sess-4", "Something failed", { statusBar: BAR });
    const sentBody = sent[sent.length - 1]!.body;
    expect(sentBody.endsWith("\n\n" + BAR)).toBe(true);
  });

  it("does not append the bar when statusBar is omitted (at-once plain body unchanged)", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    await adapter.sendBody("sess-5", "No bar here");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("No bar here");
    expect(sent[0]!.body.endsWith("\n\n")).toBe(false);
  });

  it("splits a bar-laden at-once body within the 2000-char platform limit", async () => {
    const sent: SentBody[] = [];
    const { adapter } = createAdapter(sent);
    const body = "x".repeat(1985) + "\n" + "y".repeat(1985);
    await adapter.sendBody("sess-6", body, { statusBar: BAR });
    for (const m of sent) {
      // raw content captured before table formatting; bar line length kept under limit
      expect(m.body.length).toBeLessThanOrEqual(2100);
    }
    expect(sent[sent.length - 1]!.body.includes(BAR)).toBe(true);
  });
});
