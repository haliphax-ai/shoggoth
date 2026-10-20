import { describe, it, vi, beforeEach, afterEach } from "vitest";
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
    createThread: async () => ({ id: "t1" }),
    deleteChannel: async () => {},
    getMessage: async () => ({ id: "m1" }),
    getChannelMessages: async () => [],
    createMessageReaction: async () => {},
    triggerTypingIndicator: async () => {},
    async interactionCallback(id, token, body) {
      calls.push({ method: "interactionCallback", args: [id, token, body] });
    },
    async editOriginalInteractionResponse(applicationId, token, body) {
      calls.push({ method: "editOriginalInteractionResponse", args: [applicationId, token, body] });
    },
  };
}

function stubLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

const SESSION = "agent:main:discord:channel:abc";

type Body = { type: number; data: Record<string, unknown> };

function makeHandler(
  calls: Array<{ method: string; args: unknown[] }>,
  invokeControlOp?: (op: string, payload: Record<string, unknown>) => Promise<unknown>,
  resolveSessionForChannel?: (channelId: string, guildId?: string) => string | undefined,
) {
  return createDiscordInteractionHandler({
    transport: stubTransport(calls),
    applicationId: "app-123",
    logger: stubLogger(),
    abortSession: async () => false,
    invokeControlOp: invokeControlOp ?? (async () => ({ ok: true, result: { active: false } })),
    resolveSessionForChannel: resolveSessionForChannel ?? (() => SESSION),
  });
}

function slashCruiseEvent(
  options: Array<{ name: string; value: string }>,
): DiscordInteractionEvent {
  return {
    kind: "interaction_create",
    id: "int-1",
    token: "tok-1",
    type: 2,
    channelId: "ch-1",
    guildId: "g-1",
    userId: "u-1",
    data: { name: "cruise", options },
  };
}

function modalSubmitEvent(
  customId: string,
  values: Record<string, string>,
): DiscordInteractionEvent {
  return {
    kind: "interaction_create",
    id: "int-2",
    token: "tok-2",
    type: 5,
    channelId: "ch-1",
    guildId: "g-1",
    userId: "u-1",
    data: {
      custom_id: customId,
      components: Object.entries(values).map(([id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id: id, value }],
      })),
    },
  };
}

describe("cruise slash command", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates directly when yes and no are both provided (no modal)", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      return { ok: true, result: { active: true, policy: {}, warnings: [] } };
    });

    handler(
      slashCruiseEvent([
        { name: "yes", value: "approve routine ops" },
        { name: "no", value: "deny risky ops" },
        { name: "escalate", value: "ask me when uncertain" },
        { name: "model", value: "typesafe-main/jev-latest" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(invoked.length, 1);
    assert.strictEqual(invoked[0]!.op, "hitl_cruise_control");
    assert.deepStrictEqual(invoked[0]!.payload, {
      session_id: SESSION,
      yes: "approve routine ops",
      no: "deny risky ops",
      escalate: "ask me when uncertain",
      model: "typesafe-main/jev-latest",
    });
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.match(body.data.content as string, /🚗 Cruise control activated/);
    assert.match(body.data.content as string, /with escalation route/);
  });

  it("surfaces activation warnings in the response", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async () => ({
      ok: true,
      result: { active: true, policy: {}, warnings: ["no cruise control model provided"] },
    }));
    handler(
      slashCruiseEvent([
        { name: "yes", value: "y" },
        { name: "no", value: "n" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(50);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.match(body.data.content as string, /⚠️ no cruise control model provided/);
  });

  it("deactivates when no options are given and cruise control is active", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      if (payload.deactivate === true) {
        return { ok: true, result: { active: false, cleared: true } };
      }
      return { ok: true, result: { active: true, policy: { yes: "y", no: "n" } } };
    });

    handler(slashCruiseEvent([]));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(invoked.length, 2);
    assert.strictEqual(invoked[0]!.payload.deactivate, undefined); // status query
    assert.strictEqual(invoked[1]!.payload.deactivate, true);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.match(body.data.content as string, /🚗 Cruise control deactivated/);
  });

  it("opens the activation modal (empty) when no options are given and inactive", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async () => ({
      ok: true,
      result: { active: false, policy: null },
    }));

    handler(slashCruiseEvent([]));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 9); // modal
    assert.strictEqual(body.data.custom_id, "cruise_modal");
    const components = body.data.components as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    assert.strictEqual(components.length, 3);
    assert.deepStrictEqual(
      components.map((c) => c.components[0]!.custom_id),
      ["yes", "no", "escalate"],
    );
    assert.strictEqual(components[0]!.components[0]!.required, true);
    assert.strictEqual(components[1]!.components[0]!.required, true);
    assert.strictEqual(components[2]!.components[0]!.required, false);
    assert.strictEqual(components[0]!.components[0]!.value, undefined);
  });

  it("opens the modal prefilled when only some options are provided", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls);

    handler(
      slashCruiseEvent([
        { name: "yes", value: "approve routine ops" },
        { name: "model", value: "typesafe-main/jev-latest" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(50);

    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 9);
    // The model rides in the custom_id when the required guidance is incomplete.
    assert.strictEqual(body.data.custom_id, "cruise_modal|typesafe-main/jev-latest");
    const components = body.data.components as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    assert.strictEqual(components[0]!.components[0]!.value, "approve routine ops");
    assert.strictEqual(components[1]!.components[0]!.value, undefined);
    assert.strictEqual(components[2]!.components[0]!.value, undefined);
  });

  it("activates from a modal submit with the channel-bound session", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      return { ok: true, result: { active: true, policy: {}, warnings: [] } };
    });

    handler(
      modalSubmitEvent("cruise_modal", {
        yes: "approve routine ops",
        no: "deny risky ops",
        escalate: "ask me",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(invoked.length, 1);
    assert.deepStrictEqual(invoked[0]!.payload, {
      session_id: SESSION,
      yes: "approve routine ops",
      no: "deny risky ops",
      escalate: "ask me",
    });
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.match(body.data.content as string, /🚗 Cruise control activated/);
  });

  it("forwards a model carried in the modal custom_id", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      return { ok: true, result: { active: true, policy: {}, warnings: [] } };
    });

    handler(
      modalSubmitEvent("cruise_modal|typesafe-main/jev-latest", {
        yes: "y",
        no: "n",
        escalate: "",
      }),
    );
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(invoked[0]!.payload.model, "typesafe-main/jev-latest");
    assert.strictEqual(invoked[0]!.payload.escalate, undefined);
  });

  it("rejects a modal submit with empty required guidance", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      return { ok: true, result: {} };
    });

    handler(modalSubmitEvent("cruise_modal", { yes: "y", no: "   " }));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(invoked.length, 0);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.match(body.data.content as string, /both required/);
  });

  it("warns when no session is bound to the channel", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, undefined, () => undefined);

    handler(
      slashCruiseEvent([
        { name: "yes", value: "y" },
        { name: "no", value: "n" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(50);

    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.match(body.data.content as string, /No session bound/);
  });
});
