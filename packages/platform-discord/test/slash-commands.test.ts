import { describe, it } from "vitest";
import assert from "node:assert";
import {
  createDiscordInteractionHandler,
  registerDiscordSlashCommands,
} from "../src/slash-commands";
import type { DiscordInteractionEvent } from "../src/interaction";
import type { DiscordRestTransport } from "../src/transport";

function stubTransport(calls: Array<{ method: string; args: unknown[] }>): DiscordRestTransport {
  return {
    openDmChannel: async () => "dm-ch",
    createMessage: async () => ({ id: "m1" }),
    createMessageWithFiles: async () => ({ id: "m1" }),
    editMessage: async () => {},
    deleteMessage: async () => {},
    createThreadFromMessage: async () => ({ id: "t1" }),
    deleteChannel: async () => {},
    getMessage: async () => ({ id: "m1" }),
    getChannelMessages: async () => [],
    createMessageReaction: async () => {},
    triggerTypingIndicator: async () => {},
    async interactionCallback(id, token, body) {
      calls.push({ method: "interactionCallback", args: [id, token, body] });
    },
    async registerGlobalCommands(appId, commands) {
      calls.push({ method: "registerGlobalCommands", args: [appId, commands] });
    },
  };
}

function stubLogger() {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
  };
}

describe("createDiscordInteractionHandler", () => {
  it("handles abort command and responds with success", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      logger: stubLogger(),
      abortSession: async () => true,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-1",
      token: "tok-1",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: { name: "abort" },
    };

    handler(ev);
    // Allow the async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.method, "interactionCallback");
    const [id, token, body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.strictEqual(id, "int-1");
    assert.strictEqual(token, "tok-1");
    assert.strictEqual(body.type, 4);
    assert.ok(body.data.content.includes("abort initiated"));
  });

  it("handles abort command with no active session", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      logger: stubLogger(),
      abortSession: async () => false,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-2",
      token: "tok-2",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "abort" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.ok(body.data.content.includes("No active session"));
  });

  it("passes session_id option to abortSession", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const abortCalls: Array<string | undefined> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      logger: stubLogger(),
      abortSession: async (sid) => {
        abortCalls.push(sid);
        return true;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-3",
      token: "tok-3",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        name: "abort",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:abc" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(abortCalls, ["agent:main:discord:abc"]);
  });

  it("ignores non-APPLICATION_COMMAND interactions", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      logger: stubLogger(),
      abortSession: async () => true,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-4",
      token: "tok-4",
      type: 1, // PING
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "abort" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 0);
  });

  it("responds with error when abort throws", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      logger: stubLogger(),
      abortSession: async () => {
        throw new Error("session not found");
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-5",
      token: "tok-5",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "abort" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.ok(body.data.content.includes("Abort failed"));
  });
});

describe("registerDiscordSlashCommands", () => {
  it("calls registerGlobalCommands with abort command definition", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);

    await registerDiscordSlashCommands({
      transport,
      applicationId: "app-123",
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.method, "registerGlobalCommands");
    const [appId, commands] = calls[0]!.args as [string, Array<Record<string, unknown>>];
    assert.strictEqual(appId, "app-123");
    assert.strictEqual(commands.length, 5);
    assert.ok(commands.some((c) => c.name === "abort"));
    assert.ok(commands.some((c) => c.name === "new"));
    assert.ok(commands.some((c) => c.name === "reset"));
    assert.ok(commands.some((c) => c.name === "compact"));
    assert.ok(commands.some((c) => c.name === "status"));
  });
});
