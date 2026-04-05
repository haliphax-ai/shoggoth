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
      applicationId: "app-123",
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
      applicationId: "app-123",
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
      applicationId: "app-123",
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
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:channel:abc" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(abortCalls, ["agent:main:discord:channel:abc"]);
  });

  it("ignores non-APPLICATION_COMMAND interactions", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
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
      applicationId: "app-123",
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

  it("handles model command with explicit session_id", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async (op, payload) => ({
        ok: true,
        result: {
          session_id: payload.session_id,
          model_selection: null,
          effective_models: { providerId: "anthropic", model: "claude-3-5-sonnet" },
        },
      }),
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-6",
      token: "tok-6",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        name: "model",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:channel:abc" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.strictEqual(body.type, 4);
    assert.ok(body.data.content.includes("Model Configuration"));
    assert.ok(body.data.content.includes("agent:main:discord:channel:abc"));
    assert.ok(body.data.content.includes("anthropic"));
  });

  it("handles model command with channel resolution", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async (op, payload) => ({
        ok: true,
        result: {
          session_id: payload.session_id,
          model_selection: { providerId: "openai", model: "gpt-4" },
          effective_models: { providerId: "openai", model: "gpt-4" },
        },
      }),
      resolveSessionForChannel: (channelId) => {
        if (channelId === "ch-1") return "agent:main:discord:channel:abc";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-7",
      token: "tok-7",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.ok(body.data.content.includes("Selection:"));
    assert.ok(body.data.content.includes("openai"));
  });

  it("handles model command with no session bound to channel", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({ ok: false, error: "not found" }),
      resolveSessionForChannel: () => undefined,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-8",
      token: "tok-8",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.ok(body.data.content.includes("No session bound"));
  });

  it("handles model command control op error", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({
        ok: false,
        error: "session not found",
      }),
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-9",
      token: "tok-9",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        name: "model",
        options: [{ name: "session_id", type: 3, value: "agent:main:discord:channel:abc" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, { type: number; data: { content: string } }];
    assert.ok(body.data.content.includes("Failed to get model"));
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
    assert.strictEqual(commands.length, 7);
    assert.ok(commands.some((c) => c.name === "abort"));
    assert.ok(commands.some((c) => c.name === "new"));
    assert.ok(commands.some((c) => c.name === "reset"));
    assert.ok(commands.some((c) => c.name === "compact"));
    assert.ok(commands.some((c) => c.name === "status"));
    assert.ok(commands.some((c) => c.name === "model"));
    assert.ok(commands.some((c) => c.name === "queue"));
  });

  it("registers model command with correct options", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);

    await registerDiscordSlashCommands({
      transport,
      applicationId: "app-123",
    });

    const [, commands] = calls[0]!.args as [string, Array<Record<string, unknown>>];
    const modelCmd = commands.find((c) => c.name === "model");
    assert.ok(modelCmd);
    const options = modelCmd!.options as Array<Record<string, unknown>>;
    assert.ok(options.some((o) => o.name === "session_id"));
    assert.ok(options.some((o) => o.name === "agent_id"));
    assert.ok(options.some((o) => o.name === "model_selection"));
  });
});
