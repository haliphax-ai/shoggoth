import { describe, it } from "vitest";
import assert from "node:assert";
import {
  createDiscordInteractionHandler,
  registerDiscordSlashCommands,
  deregisterDiscordSlashCommands,
} from "../src/slash-commands";
import { createDiscordMessagingShutdownDrain } from "../src/bootstrap";
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

  it("steers the channel's session when no session_id is provided", async () => {
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
        return { ok: true };
      },
      resolveSessionForChannel: (channelId) =>
        channelId === "ch-1" ? "agent:sub:discord:channel:ch-1" : undefined,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-steer-1",
      token: "tok-steer-1",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: {
        name: "steer",
        options: [{ name: "prompt", type: 3, value: "Focus on the failing tests first." }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    // Dispatched session_steer against the channel's resolved session
    assert.strictEqual(invokeOps.length, 1);
    assert.strictEqual(invokeOps[0]!.op, "session_steer");
    assert.strictEqual(invokeOps[0]!.payload.session_id, "agent:sub:discord:channel:ch-1");
    assert.strictEqual(invokeOps[0]!.payload.prompt, "Focus on the failing tests first.");
    assert.strictEqual(invokeOps[0]!.payload.delivery, undefined);

    // Responded with success
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.strictEqual(body.type, 4);
    assert.ok(body.data.content.includes("Steering prompt sent"));
  });

  it("prefers an explicit session_id and passes internal delivery through", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const invokeOps: Array<{ op: string; payload: Record<string, unknown> }> = [];
    let resolveCalls = 0;
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => true,
      invokeControlOp: async (op, payload) => {
        invokeOps.push({ op, payload });
        return { ok: true };
      },
      resolveSessionForChannel: () => {
        resolveCalls += 1;
        return "agent:other:discord:channel:ch-9";
      },
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-steer-2",
      token: "tok-steer-2",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: {
        name: "steer",
        options: [
          { name: "prompt", type: 3, value: "Wrap up after this turn." },
          { name: "session_id", type: 3, value: "agent:target:discord:channel:ch-7" },
          { name: "delivery", type: 3, value: "internal" },
        ],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(resolveCalls, 0, "Should not resolve from channel when session_id given");
    assert.strictEqual(invokeOps.length, 1);
    assert.strictEqual(invokeOps[0]!.op, "session_steer");
    assert.strictEqual(invokeOps[0]!.payload.session_id, "agent:target:discord:channel:ch-7");
    assert.strictEqual(invokeOps[0]!.payload.prompt, "Wrap up after this turn.");
    assert.strictEqual(invokeOps[0]!.payload.delivery, "internal");
  });

  it("warns when no session is bound and no session_id is provided", async () => {
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
        return { ok: true };
      },
      resolveSessionForChannel: () => undefined,
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-steer-3",
      token: "tok-steer-3",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: {
        name: "steer",
        options: [{ name: "prompt", type: 3, value: "Anyone there?" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(invokeOps.length, 0, "Should not invoke the control op");
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.ok(body.data.content.includes("No session bound to this channel"));
  });

  it("surfaces session_steer failures in the response", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const handler = createDiscordInteractionHandler({
      transport,
      applicationId: "app-123",
      logger: stubLogger(),
      abortSession: async () => true,
      invokeControlOp: async () => ({ ok: false, error: "ERR_SESSION_INACTIVE" }),
      resolveSessionForChannel: () => "agent:sub:discord:channel:ch-1",
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-steer-4",
      token: "tok-steer-4",
      type: 2,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: {
        name: "steer",
        options: [{ name: "prompt", type: 3, value: "Hello?" }],
      },
    };

    handler(ev);
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [
      string,
      string,
      { type: number; data: { content: string } },
    ];
    assert.ok(body.data.content.includes("Steer failed"));
    assert.ok(body.data.content.includes("ERR_SESSION_INACTIVE"));
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
    assert.strictEqual(commands.length, 9);
    assert.ok(commands.some((c) => c.name === "abort"));
    assert.ok(commands.some((c) => c.name === "steer"));
    assert.ok(commands.some((c) => c.name === "new"));
    assert.ok(commands.some((c) => c.name === "reset"));
    assert.ok(commands.some((c) => c.name === "compact"));
    assert.ok(commands.some((c) => c.name === "status"));
    assert.ok(commands.some((c) => c.name === "model"));
    assert.ok(commands.some((c) => c.name === "queue"));
  });

  it("registers steer command with prompt, session_id, and delivery options", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);

    await registerDiscordSlashCommands({
      transport,
      applicationId: "app-123",
    });

    const [, commands] = calls[0]!.args as [string, Array<Record<string, unknown>>];
    const steerCmd = commands.find((c) => c.name === "steer");
    assert.ok(steerCmd, "Steer command should be registered");
    const options = steerCmd!.options as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(options), "Steer command should have options");

    const promptOpt = options.find((o) => o.name === "prompt");
    assert.ok(promptOpt, "Should have prompt option");
    assert.strictEqual(promptOpt!.required, true, "prompt should be required");

    const sessionOpt = options.find((o) => o.name === "session_id");
    assert.ok(sessionOpt, "Should have session_id option");
    assert.strictEqual(sessionOpt!.required, false, "session_id should be optional");

    const deliveryOpt = options.find((o) => o.name === "delivery");
    assert.ok(deliveryOpt, "Should have delivery option");
    const choices = deliveryOpt!.choices as Array<{ value: string }>;
    assert.deepStrictEqual(
      choices.map((c) => c.value),
      ["surface", "internal"],
    );
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

describe("deregisterDiscordSlashCommands", () => {
  it("bulk-overwrites the global command list with an empty array", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);

    await deregisterDiscordSlashCommands({
      transport,
      applicationId: "app-123",
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.method, "registerGlobalCommands");
    const [appId, commands] = calls[0]!.args as [string, unknown[]];
    assert.strictEqual(appId, "app-123");
    assert.deepStrictEqual(commands, []);
  });
});

describe("createDiscordMessagingShutdownDrain", () => {
  it("de-registers slash commands before stopping when this instance registered them", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const registrationRef = { current: "app-123" };
    let stopped = false;

    const drain = createDiscordMessagingShutdownDrain({
      registrationRef,
      transport,
      logger: stubLogger(),
      stop: () => {
        assert.strictEqual(
          calls.length,
          1,
          "slash commands must be de-registered before the transport stops",
        );
        stopped = true;
      },
    });

    await drain();

    assert.strictEqual(stopped, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.method, "registerGlobalCommands");
    const [appId, commands] = calls[0]!.args as [string, unknown[]];
    assert.strictEqual(appId, "app-123");
    assert.deepStrictEqual(commands, []);
    // The registration state is consumed, so a later stop path cannot repeat it.
    assert.strictEqual(registrationRef.current, undefined);
  });

  it("does not de-register when this instance never registered (disabled or failed)", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const registrationRef = { current: undefined };
    let stopped = false;

    const drain = createDiscordMessagingShutdownDrain({
      registrationRef,
      transport,
      logger: stubLogger(),
      stop: () => {
        stopped = true;
      },
    });

    await drain();

    assert.strictEqual(calls.length, 0, "must not touch the global command list");
    assert.strictEqual(stopped, true);
  });

  it("de-registers at most once across repeated drain invocations", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport = stubTransport(calls);
    const registrationRef = { current: "app-123" };

    const drain = createDiscordMessagingShutdownDrain({
      registrationRef,
      transport,
      logger: stubLogger(),
      stop: () => {},
    });

    await drain();
    await drain();

    assert.strictEqual(calls.length, 1);
  });

  it("still stops messaging and does not reject when the de-registration REST call fails", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const transport: DiscordRestTransport = {
      ...stubTransport(calls),
      registerGlobalCommands: async () => {
        throw new Error("Discord REST 500");
      },
    };
    const warns: string[] = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => {
        warns.push(msg);
      },
    };
    const registrationRef = { current: "app-123" };
    let stopped = false;

    const drain = createDiscordMessagingShutdownDrain({
      registrationRef,
      transport,
      logger,
      stop: () => {
        stopped = true;
      },
    });

    await drain();

    assert.strictEqual(stopped, true, "messaging must still stop after a REST failure");
    assert.deepStrictEqual(warns, ["discord.slash_commands.deregistration_failed"]);
    assert.strictEqual(registrationRef.current, undefined);
  });
});
