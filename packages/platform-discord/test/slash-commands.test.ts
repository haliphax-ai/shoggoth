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
    createThread: async () => ({ id: "t1" }),
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
    const [id, token, body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
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
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
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
        options: [
          {
            name: "session_id",
            type: 3,
            value: "agent:main:discord:channel:abc",
          },
        ],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(abortCalls, ["agent:main:discord:channel:abc"]);
  });

  it("resolves session from resolveSessionForChannel when channelId is a thread", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const invokeOps: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => true,
      invokeControlOp: async (op, payload) => {
        invokeOps.push({ op, payload });
        return {
          ok: true,
          result: {
            session: { id: "thread-session", status: "active", contextSegmentId: "seg-1" },
            stats: null,
            model: null,
            formattedStats: null,
            queueDepth: null,
          },
        };
      },
      resolveSessionForChannel: (channelId) => {
        // Simulates dynamic thread binding resolution
        if (channelId === "thread-999") return "thread-session";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-thread",
      token: "tok-thread",
      type: 2,
      channelId: "thread-999",
      guildId: "g-1",
      userId: "u-1",
      data: { name: "status" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    // Should have invoked session_context_status with the resolved thread session
    assert.strictEqual(invokeOps.length, 1);
    assert.strictEqual(invokeOps[0]!.op, "session_context_status");
    assert.strictEqual(invokeOps[0]!.payload.session_id, "thread-session");

    // Should respond with session status
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.ok(body.data.content.includes("thread-session"));
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
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.ok(body.data.content.includes("Abort failed"));
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
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.ok(body.data.content.includes("No session bound"));
  });

  // PHASE 3 RED: Failing tests for dropdown flow
  it("handles /model command with provider select menu (dropdown flow)", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({
        ok: true,
        result: { effective_models: { providerId: "anthropic", model: "claude-3-5-sonnet" } },
      }),
      getModelsConfig: async () => ({
        providers: [
          { id: "anthropic", name: "Anthropic" },
          { id: "openai", name: "OpenAI" },
        ],
      }),
      resolveSessionForChannel: (channelId) => {
        if (channelId === "ch-1") return "agent:main:discord:channel:abc";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-10",
      token: "tok-10",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: Record<string, unknown> },
    ];

    // Should respond with CHANNEL_MESSAGE_WITH_SOURCE
    assert.strictEqual(body.type, 4, "Expected response type 4 (CHANNEL_MESSAGE_WITH_SOURCE)");

    // Should be ephemeral
    assert.strictEqual(body.data.flags, 64, "Expected ephemeral flag (64)");

    // Should have components array with action row containing StringSelect
    assert.ok(Array.isArray(body.data.components), "Expected components array");
    assert.ok(body.data.components.length > 0, "Expected at least one component");

    const actionRow = body.data.components[0];
    assert.ok(actionRow, "Expected action row component");
    assert.strictEqual(actionRow.type, 1, "Expected action row type 1");

    const selectComponent = actionRow.components[0];
    assert.ok(selectComponent, "Expected select component in action row");
    assert.strictEqual(selectComponent.type, 3, "Expected StringSelect type 3");
    assert.ok(
      selectComponent.custom_id?.startsWith("model_select"),
      `Expected custom_id to start with 'model_select', got: ${selectComponent.custom_id}`,
    );
  });

  it("calls getModelsConfig to build provider options", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const getModelsConfigCalls: number[] = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({
        ok: true,
        result: { effective_models: { providerId: "anthropic", model: "claude-3-5-sonnet" } },
      }),
      getModelsConfig: async () => {
        getModelsConfigCalls.push(Date.now());
        return {
          providers: [
            { id: "anthropic", name: "Anthropic" },
            { id: "openai", name: "OpenAI" },
          ],
        };
      },
      resolveSessionForChannel: (channelId) => {
        if (channelId === "ch-1") return "agent:main:discord:channel:abc";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-11",
      token: "tok-11",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(getModelsConfigCalls.length, 1, "getModelsConfig should be called once");

    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: Record<string, unknown> },
    ];

    const actionRow = body.data.components![0] as {
      components: Array<{ options?: Array<{ value: string }> }>;
    };
    const selectComponent = actionRow.components[0];
    assert.ok(selectComponent.options, "Expected options array in select component");
    assert.strictEqual(
      selectComponent.options.length,
      3,
      "Expected 3 options (custom + 2 providers)",
    );
    assert.ok(
      selectComponent.options.some((opt) => opt.value === "anthropic"),
      "Expected anthropic option",
    );
    assert.ok(
      selectComponent.options.some((opt) => opt.value === "openai"),
      "Expected openai option",
    );
  });

  it("responds with modal when getModelsConfig returns null providers", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({ ok: true, result: { effective_models: null } }),
      getModelsConfig: async () => ({
        providers: null,
      }),
      resolveSessionForChannel: (channelId) => {
        if (channelId === "ch-1") return "agent:main:discord:channel:abc";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-12",
      token: "tok-12",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: Record<string, unknown> },
    ];

    // Should respond with modal (type 9)
    assert.strictEqual(body.type, 9, "Expected response type 9 (MODAL)");
  });

  it("responds with modal when getModelsConfig returns empty providers array", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => false,
      invokeControlOp: async () => ({ ok: true, result: { effective_models: null } }),
      getModelsConfig: async () => ({
        providers: [],
      }),
      resolveSessionForChannel: (channelId) => {
        if (channelId === "ch-1") return "agent:main:discord:channel:abc";
        return undefined;
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-13",
      token: "tok-13",
      type: 2,
      channelId: "ch-1",
      userId: "u-1",
      data: { name: "model" },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: Record<string, unknown> },
    ];

    // Should respond with modal (type 9)
    assert.strictEqual(body.type, 9, "Expected response type 9 (MODAL)");
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
    assert.strictEqual(commands.length, 8);
    assert.ok(commands.some((c) => c.name === "abort"));
    assert.ok(commands.some((c) => c.name === "new"));
    assert.ok(commands.some((c) => c.name === "reset"));
    assert.ok(commands.some((c) => c.name === "compact"));
    assert.ok(commands.some((c) => c.name === "status"));
    assert.ok(commands.some((c) => c.name === "model"));
    assert.ok(commands.some((c) => c.name === "queue"));
  });

  it("registers model command without model_selection option (dropdown flow)", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);

    await registerDiscordSlashCommands({
      transport,
      applicationId: "app-123",
    });

    const [, commands] = calls[0]!.args as [string, Array<Record<string, unknown>>];
    const modelCmd = commands.find((c) => c.name === "model");
    assert.ok(modelCmd, "Model command should be registered");
    const options = modelCmd!.options as Array<Record<string, unknown>> | undefined;
    assert.ok(options, "Model command should have options");

    // Should have session_id and agent_id options
    assert.ok(
      options.some((o) => o.name === "session_id"),
      "Should have session_id option",
    );
    assert.ok(
      options.some((o) => o.name === "agent_id"),
      "Should have agent_id option",
    );

    // Should NOT have model_selection option (dropdown flow)
    assert.ok(
      !options.some((o) => o.name === "model_selection"),
      "Should NOT have model_selection option (dropdown flow)",
    );
  });
});
