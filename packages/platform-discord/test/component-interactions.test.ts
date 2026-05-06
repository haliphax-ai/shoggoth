import { describe, it } from "vitest";
import assert from "node:assert";
import { createDiscordInteractionHandler } from "../src/slash-commands";
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

describe("Component Interaction Handler (Phase 4 RED)", () => {
  describe("Provider select → custom", () => {
    it("responds with modal when user selects '(custom)' option", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async () => ({ ok: true }),
      });

      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-1",
        token: "tok-1",
        type: 3, // MESSAGE_COMPONENT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: "model_select|provider|agent:main:discord:channel:abc",
          values: ["__custom__"],
          component_type: 3, // STRING_SELECT
        },
      };

      handler(ev);
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]!.method, "interactionCallback");
      const [id, token, body] = calls[0]!.args as [
        string,
        string,
        { type: number; data: { title: string; custom_id: string; components: unknown[] } },
      ];
      assert.strictEqual(id, "int-1");
      assert.strictEqual(token, "tok-1");
      assert.strictEqual(body.type, 9); // MODAL response
      assert.strictEqual(body.data.title, "Enter Model");
      assert.ok(body.data.custom_id.startsWith("model_select|custom_modal|"));
      assert.ok(Array.isArray(body.data.components));
      assert.strictEqual(body.data.components.length, 1);
    });
  });

  describe("Provider select → real provider", () => {
    it("responds with model select when user selects a real provider", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async () => ({ ok: true }),
        getModelsConfig: async () => ({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [{ name: "claude-3-5-sonnet" }, { name: "claude-3-opus" }],
            },
          ],
        }),
      });

      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-2",
        token: "tok-2",
        type: 3, // MESSAGE_COMPONENT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: "model_select|provider|agent:main:discord:channel:abc",
          values: ["anthropic"],
          component_type: 3, // STRING_SELECT
        },
      };

      handler(ev);
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]!.method, "interactionCallback");
      const [id, token, body] = calls[0]!.args as [
        string,
        string,
        { type: number; data: { content: string; components: unknown[] } },
      ];
      assert.strictEqual(id, "int-2");
      assert.strictEqual(token, "tok-2");
      assert.strictEqual(body.type, 7); // UPDATE_MESSAGE response
      assert.ok(body.data.content.includes("Model Configuration"));
      assert.ok(Array.isArray(body.data.components));
      assert.strictEqual(body.data.components.length, 1);

      const actionRow = body.data.components[0] as { components: unknown[] };
      const selectComponent = actionRow.components[0] as { type: number; custom_id: string };
      assert.strictEqual(selectComponent.type, 3); // STRING_SELECT
      assert.ok(selectComponent.custom_id.includes("model_select|model|"));
      assert.ok(selectComponent.custom_id.includes("anthropic"));
    });
  });

  describe("Model select → execute", () => {
    it("calls invokeControlOp and responds with success when model is selected", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const invokeCalls: Array<{ op: string; payload: unknown }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async (op, payload) => {
          invokeCalls.push({ op, payload });
          return { ok: true };
        },
      });

      const sessionId = "agent:main:discord:channel:abc";
      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-3",
        token: "tok-3",
        type: 3, // MESSAGE_COMPONENT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: `model_select|model|${sessionId}|anthropic`,
          values: ["claude-3-5-sonnet"],
          component_type: 3, // STRING_SELECT
        },
      };

      handler(ev);
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]!.method, "interactionCallback");
      const [id, token, body] = calls[0]!.args as [
        string,
        string,
        { type: number; data: { content: string; components: unknown[] } },
      ];
      assert.strictEqual(id, "int-3");
      assert.strictEqual(token, "tok-3");
      assert.strictEqual(body.type, 7); // UPDATE_MESSAGE response
      assert.ok(body.data.content.includes("success") || body.data.content.includes("✅"));
      assert.ok(Array.isArray(body.data.components));
      assert.strictEqual(body.data.components.length, 0); // Empty components

      // Verify invokeControlOp was called correctly
      assert.strictEqual(invokeCalls.length, 1);
      assert.strictEqual(invokeCalls[0]!.op, "session_model");
      assert.deepStrictEqual(invokeCalls[0]!.payload, {
        session_id: sessionId,
        model_selection: { model: "anthropic/claude-3-5-sonnet" },
      });
    });
  });

  describe("Modal submit", () => {
    it("calls invokeControlOp and responds with success when modal is submitted with valid input", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const invokeCalls: Array<{ op: string; payload: unknown }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async (op, payload) => {
          invokeCalls.push({ op, payload });
          return { ok: true };
        },
      });

      const sessionId = "agent:main:discord:channel:abc";
      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-4",
        token: "tok-4",
        type: 5, // MODAL_SUBMIT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: `model_select|custom_modal|${sessionId}`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4, // TEXT_INPUT
                  custom_id: "model_input",
                  value: "openai/gpt-4o",
                },
              ],
            },
          ],
        },
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
      assert.strictEqual(id, "int-4");
      assert.strictEqual(token, "tok-4");
      assert.strictEqual(body.type, 4); // CHANNEL_MESSAGE_WITH_SOURCE response
      assert.ok(body.data.content.includes("success") || body.data.content.includes("✅"));

      // Verify invokeControlOp was called correctly
      assert.strictEqual(invokeCalls.length, 1);
      assert.strictEqual(invokeCalls[0]!.op, "session_model");
      assert.deepStrictEqual(invokeCalls[0]!.payload, {
        session_id: sessionId,
        model_selection: { model: "openai/gpt-4o" },
      });
    });
  });

  describe("Unknown custom_id", () => {
    it("ignores type 3 interaction with custom_id that doesn't start with 'model_select'", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async () => ({ ok: true }),
      });

      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-5",
        token: "tok-5",
        type: 3, // MESSAGE_COMPONENT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: "some_other_component|id",
          values: ["some_value"],
          component_type: 3,
        },
      };

      handler(ev);
      await new Promise((r) => setTimeout(r, 50));

      // Should not call interactionCallback (no response)
      assert.strictEqual(calls.length, 0);
    });
  });

  describe("Invalid modal input", () => {
    it("responds with error when modal input doesn't contain '/' separator", async () => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const transport = stubTransport(calls);
      const handler = createDiscordInteractionHandler({
        transport,
        applicationId: "app-123",
        logger: stubLogger(),
        abortSession: async () => false,
        invokeControlOp: async () => ({ ok: true }),
      });

      const sessionId = "agent:main:discord:channel:abc";
      const ev: DiscordInteractionEvent = {
        kind: "interaction_create",
        id: "int-6",
        token: "tok-6",
        type: 5, // MODAL_SUBMIT
        channelId: "ch-1",
        userId: "u-1",
        data: {
          custom_id: `model_select|custom_modal|${sessionId}`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4, // TEXT_INPUT
                  custom_id: "model_input",
                  value: "invalid-model-name",
                },
              ],
            },
          ],
        },
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
      assert.strictEqual(id, "int-6");
      assert.strictEqual(token, "tok-6");
      assert.strictEqual(body.type, 4); // CHANNEL_MESSAGE_WITH_SOURCE response
      assert.ok(
        body.data.content.includes("error") ||
          body.data.content.includes("⚠️") ||
          body.data.content.includes("invalid"),
      );
    });
  });
});
