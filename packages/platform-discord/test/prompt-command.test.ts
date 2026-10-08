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
    async registerGlobalCommands(appId, commands) {
      calls.push({ method: "registerGlobalCommands", args: [appId, commands] });
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
    invokeControlOp: invokeControlOp ?? (async () => ({ ok: true, result: { prompts: [] } })),
    resolveSessionForChannel: resolveSessionForChannel ?? (() => SESSION),
  });
}

function slashPromptEvent(
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
    data: { name: "prompt", options },
  };
}

describe("prompt slash command", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("responds with a dropdown of all prompts when slug omitted", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async (op) => {
      assert.strictEqual(op, "prompt_list");
      return {
        ok: true,
        result: {
          prompts: [
            { slug: "alpha", source: "workspace", placeholders: ["x"] },
            { slug: "beta", source: "global", placeholders: [] },
          ],
        },
      };
    });

    handler(slashPromptEvent([]));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.strictEqual(body.data.flags, 64); // ephemeral
    const components = body.data.components as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    const select = components[0]!.components[0]!;
    assert.strictEqual(select.custom_id, `prompt_select|${SESSION}`);
    assert.strictEqual(select.placeholder, "Select a canned prompt");
    assert.strictEqual((select.default_values as unknown[] | undefined)?.length ?? 0, 0);
    const options = select.options as Array<{ label: string; value: string }>;
    assert.deepStrictEqual(
      options.map((o) => o.value),
      ["alpha", "beta"],
    );
  });

  it("opens the parameter modal directly when the slug argument has placeholders", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    // beta has placeholders, so the slash command answers with the parameter
    // modal directly — a pre-selected dropdown would be a dead end, since
    // default_values pre-selection never fires the select onchange event.
    const handler = makeHandler(calls, async () => ({
      ok: true,
      result: {
        prompts: [
          { slug: "alpha", source: "workspace", placeholders: [] },
          { slug: "beta", source: "global", placeholders: ["topic", "audience"] },
        ],
      },
    }));

    handler(slashPromptEvent([{ name: "slug", value: "beta" }]));
    await vi.advanceTimersByTimeAsync(50);

    // Exactly one callback: the modal (type 9) — no dropdown is rendered.
    assert.strictEqual(calls.length, 1, "should not render a dropdown");
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 9); // modal
    assert.strictEqual(body.data.custom_id, `prompt_modal|${SESSION}|beta`);
    assert.strictEqual(body.data.title, "Prompt: beta");
    assert.strictEqual(body.data.flags, undefined);
    const components = body.data.components as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    assert.strictEqual(components.length, 2, "one input per placeholder");
    assert.deepStrictEqual(
      components.map((c) => c.components[0]!.custom_id),
      ["topic", "audience"],
    );
    assert.ok(components.every((c) => c.components[0]!.required === false));
  });

  it("returns an ephemeral error for a slug with more than 5 placeholders", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      return {
        ok: true,
        result: {
          prompts: [{ slug: "huge", placeholders: ["a", "b", "c", "d", "e", "f"] }],
        },
      };
    });

    handler(slashPromptEvent([{ name: "slug", value: "huge" }]));
    await vi.advanceTimersByTimeAsync(50);

    // One ephemeral error callback; no modal, no dropdown, no prompt run.
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.strictEqual(body.data.flags, 64); // ephemeral
    assert.ok((body.data.content as string).includes("6 parameters"));
    assert.ok((body.data.content as string).includes("at most 5"));
    assert.ok(!invoked.some((c) => c.op === "prompt"), "prompt op must not run");
  });

  it("runs the prompt directly for a slug without placeholders (no dropdown)", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      if (op === "prompt_list") {
        return { ok: true, result: { prompts: [{ slug: "plain", placeholders: [] }] } };
      }
      return { ok: true, result: { reply: "ok" } };
    });

    handler(slashPromptEvent([{ name: "slug", value: "plain" }]));
    await vi.advanceTimersByTimeAsync(100);

    // The prompt op is invoked directly with the resolved routing fields.
    const promptCall = invoked.find((c) => c.op === "prompt");
    assert.ok(promptCall, "prompt op should be invoked");
    assert.strictEqual(promptCall!.payload.slug, "plain");
    assert.strictEqual(promptCall!.payload.session_id, SESSION);
    assert.strictEqual(promptCall!.payload.platform_user_id, "u-1");

    // Exactly one callback: the deferred channel-message ACK (type 5) — no
    // dropdown message is ever shown.
    const callbacks = calls.filter((c) => c.method === "interactionCallback");
    assert.strictEqual(callbacks.length, 1, "should not render a dropdown");
    const ack = callbacks[0]!.args[2] as Body;
    assert.strictEqual(ack.type, 5);
    assert.strictEqual((ack as { data?: Record<string, unknown> }).data, undefined);

    // …then the deferred response is edited with the success recap.
    const edit = calls.find((c) => c.method === "editOriginalInteractionResponse");
    assert.ok(edit, "should edit the deferred response with the outcome");
    const editBody = edit!.args[2] as { content: string; components: unknown[] };
    assert.ok(editBody.content.includes("✅ Prompt"));
    assert.ok(editBody.content.includes("`plain`"));
    assert.deepStrictEqual(editBody.components, []);
  });

  it("returns an ephemeral error without dropdown for an unknown slug", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async () => ({
      ok: true,
      result: { prompts: [{ slug: "alpha", source: "workspace", placeholders: [] }] },
    }));

    handler(slashPromptEvent([{ name: "slug", value: "nope" }]));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4);
    assert.strictEqual(body.data.flags, 64);
    assert.ok((body.data.content as string).includes("nope"));
    assert.strictEqual(body.data.components, undefined);
  });

  it("resolves session from channel when session_id omitted", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let listPayload: Record<string, unknown> = {};
    const handler = makeHandler(calls, async (op, payload) => {
      if (op === "prompt_list") {
        listPayload = payload;
        return { ok: true, result: { prompts: [{ slug: "a", placeholders: [] }] } };
      }
      return { ok: true };
    });

    handler(slashPromptEvent([]));
    await vi.advanceTimersByTimeAsync(50);

    assert.strictEqual(listPayload.session_id, SESSION);
  });
});

describe("prompt dropdown component → modal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function selectEvent(slug: string): DiscordInteractionEvent {
    return {
      kind: "interaction_create",
      id: "int-2",
      token: "tok-2",
      type: 3,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        custom_id: `prompt_select|${SESSION}`,
        values: [slug],
        component_type: 3,
      },
    };
  }

  it("opens a modal with one input per placeholder", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async (op) => {
      assert.strictEqual(op, "prompt_list");
      return {
        ok: true,
        result: {
          prompts: [{ slug: "triage", source: "workspace", placeholders: ["cardId", "note"] }],
        },
      };
    });

    handler(selectEvent("triage"));
    await vi.advanceTimersByTimeAsync(50);

    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 9); // modal
    assert.strictEqual(body.data.custom_id, `prompt_modal|${SESSION}|triage`);
    const components = body.data.components as Array<{
      components: Array<Record<string, unknown>>;
    }>;
    assert.strictEqual(components.length, 2);
    assert.deepStrictEqual(
      components.map((c) => c.components[0]!.custom_id),
      ["cardId", "note"],
    );
    assert.ok(components.every((c) => c.components[0]!.label.length <= 32));
  });

  it("defers with UPDATE (type 6) when the file has no placeholders, then edits message A", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      invoked.push({ op, payload });
      if (op === "prompt_list") {
        return { ok: true, result: { prompts: [{ slug: "plain", placeholders: [] }] } };
      }
      return { ok: true, result: { reply: "ok" } };
    });

    handler(selectEvent("plain"));
    await vi.advanceTimersByTimeAsync(100);

    const promptCall = invoked.find((c) => c.op === "prompt");
    assert.ok(promptCall);
    assert.strictEqual(promptCall!.payload.slug, "plain");
    assert.strictEqual(promptCall!.payload.session_id, SESSION);
    assert.strictEqual(promptCall!.payload.platform_user_id, "u-1");

    // The single ACK is DEFERRED_UPDATE (6), not a fresh deferred message,
    // so the edit lands on message A (the dropdown) itself.
    const callback = calls.find((c) => c.method === "interactionCallback");
    assert.ok(callback, "should ACK the selection");
    assert.strictEqual((callback!.args[2] as Body).type, 6);

    const edit = calls.find((c) => c.method === "editOriginalInteractionResponse");
    assert.ok(edit, "should edit message A with the outcome");
    const editBody = edit!.args[2] as { content: string; components: unknown[] };
    assert.ok(editBody.content.includes("✅ Prompt"));
    assert.ok(editBody.content.includes("`plain`"));
    assert.ok(editBody.content.includes(SESSION));
    assert.deepStrictEqual(editBody.components, [], "dropdown must be cleared");
  });

  it("reports an error when the prompt has more than 5 placeholders", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async () => ({
      ok: true,
      result: {
        prompts: [
          {
            slug: "huge",
            placeholders: ["a", "b", "c", "d", "e", "f"],
          },
        ],
      },
    }));

    handler(selectEvent("huge"));
    await vi.advanceTimersByTimeAsync(50);

    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 7); // UPDATE_MESSAGE
    assert.ok((body.data.content as string).includes("at most 5"));
  });
});

describe("prompt modal submit → slash handler proxy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("proxies slug + each parameter pair to the prompt op", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(calls, async (op, payload) => {
      // The ack must already be on the wire before the op dispatches — the
      // op awaits the full model turn, which cannot fit Discord's 3s window.
      const acksBeforeInvoke = calls.filter((c) => c.method === "interactionCallback");
      assert.strictEqual(acksBeforeInvoke.length, 1, "ack must precede the prompt op");
      invoked.push({ op, payload });
      return { ok: true, result: { reply: "rendered reply" } };
    });

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-3",
      token: "tok-3",
      type: 5,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        custom_id: `prompt_modal|${SESSION}|triage`,
        components: [
          { type: 1, components: [{ type: 4, custom_id: "cardId", value: "F-42" }] },
          { type: 1, components: [{ type: 4, custom_id: "note", value: "" }] },
        ],
      },
    };

    handler(ev);
    await vi.advanceTimersByTimeAsync(100);

    const promptCall = invoked.find((c) => c.op === "prompt");
    assert.ok(promptCall, "prompt op should be invoked");
    assert.deepStrictEqual(promptCall!.payload, {
      slug: "triage",
      session_id: SESSION,
      platform_user_id: "u-1",
      params: { cardId: "F-42", note: "" },
    });

    // Ack FIRST: a single UPDATE_MESSAGE (7) response rewrites message A
    // (the dropdown) in place with a pending state before the op runs —
    // components cleared.
    const callbacks = calls.filter((c) => c.method === "interactionCallback");
    assert.strictEqual(callbacks.length, 1, "modal submit ACKs exactly once");
    const ack = callbacks[0]!.args[2] as Body;
    assert.strictEqual(ack.type, 7); // UPDATE_MESSAGE
    assert.ok((ack.data.content as string).includes("⏳ Running"));
    assert.ok((ack.data.content as string).includes("`triage`"));
    assert.ok(!(ack.data.content as string).includes("rendered reply"));
    assert.deepStrictEqual(ack.data.components, []);

    // …then the outcome is delivered by editing that response.
    const edits = calls.filter((c) => c.method === "editOriginalInteractionResponse");
    assert.strictEqual(edits.length, 1, "outcome is delivered via a single edit");
    const editBody = edits[0]!.args[2] as { content: string; components: unknown[] };
    assert.ok(editBody.content.includes("✅ Prompt"));
    assert.ok(!editBody.content.includes("rendered reply"));
    assert.deepStrictEqual(editBody.components, []);
  });

  it("reports daemon validation failures in the edit after the pending-state ack", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const handler = makeHandler(calls, async () => ({
      ok: false,
      error: "missing prompt parameters: cardId",
    }));

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-4",
      token: "tok-4",
      type: 5,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        custom_id: `prompt_modal|${SESSION}|triage`,
        components: [{ type: 1, components: [{ type: 4, custom_id: "cardId", value: "" }] }],
      },
    };

    handler(ev);
    await vi.advanceTimersByTimeAsync(100);

    // The interaction is still ACKed first with the pending state…
    const callbacks = calls.filter((c) => c.method === "interactionCallback");
    assert.strictEqual(callbacks.length, 1, "failure must still ACK first");
    const ack = callbacks[0]!.args[2] as Body;
    assert.strictEqual(ack.type, 7); // UPDATE_MESSAGE
    assert.ok((ack.data.content as string).includes("⏳ Running"));
    assert.deepStrictEqual(ack.data.components, []);

    // …and the failure is reported via a single edit of that response.
    const edits = calls.filter((c) => c.method === "editOriginalInteractionResponse");
    assert.strictEqual(edits.length, 1, "failure is delivered via a single edit");
    const editBody = edits[0]!.args[2] as { content: string; components: unknown[] };
    assert.ok(editBody.content.includes("⚠️ Prompt failed"));
    assert.ok(editBody.content.includes("missing prompt parameters"));
    assert.deepStrictEqual(editBody.components, []);
  });

  it("resolves session_id from the channel when the modal carries none", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    let resolvedWith: [string, string | undefined] | undefined;
    const handler = makeHandler(
      calls,
      async (op, payload) => {
        invoked.push({ op, payload });
        return { ok: true, result: { reply: "ok" } };
      },
      (channelId, guildId) => {
        resolvedWith = [channelId, guildId];
        return SESSION;
      },
    );

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-5",
      token: "tok-5",
      type: 5,
      channelId: "ch-1",
      guildId: "g-1",
      userId: "u-1",
      data: {
        // Blank session segment: the proxy must fall back to the channel route.
        custom_id: "prompt_modal| |triage",
        components: [{ type: 1, components: [{ type: 4, custom_id: "cardId", value: "F-42" }] }],
      },
    };

    handler(ev);
    await vi.advanceTimersByTimeAsync(100);

    assert.deepStrictEqual(resolvedWith, ["ch-1", "g-1"]);
    const promptCall = invoked.find((c) => c.op === "prompt");
    assert.ok(promptCall, "prompt op should be invoked");
    assert.strictEqual(promptCall!.payload.session_id, SESSION);
    assert.strictEqual(promptCall!.payload.platform_user_id, "u-1");
  });

  it("warns without invoking the prompt op when no session is bound to the channel", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const invoked: Array<{ op: string; payload: Record<string, unknown> }> = [];
    const handler = makeHandler(
      calls,
      async (op, payload) => {
        invoked.push({ op, payload });
        return { ok: true };
      },
      () => undefined,
    );

    const ev: DiscordInteractionEvent = {
      kind: "interaction_create",
      id: "int-6",
      token: "tok-6",
      type: 5,
      channelId: "ch-1",
      userId: "u-1",
      data: {
        custom_id: "prompt_modal| |triage",
        components: [{ type: 1, components: [{ type: 4, custom_id: "cardId", value: "F-42" }] }],
      },
    };

    handler(ev);
    await vi.advanceTimersByTimeAsync(100);

    assert.strictEqual(invoked.length, 0, "no control op should be invoked");
    assert.strictEqual(calls.length, 1);
    const [, , body] = calls[0]!.args as [string, string, Body];
    assert.strictEqual(body.type, 4); // CHANNEL_MESSAGE
    assert.strictEqual(
      body.data.content,
      "⚠️ No session bound to this channel. Provide a session_id.",
    );
    const edit = calls.find((c) => c.method === "editOriginalInteractionResponse");
    assert.strictEqual(edit, undefined, "must not defer before warning");
  });
});
