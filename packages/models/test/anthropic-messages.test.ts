import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildOpenAiToAnthropicToolNameMap,
  consumeAnthropicMessagesStream,
  createAnthropicMessagesProvider,
  mapChatMessagesToAnthropicPayload,
  normalizeAnthropicMessagesOrigin,
  normalizeAnthropicWireModelId,
} from "../src/anthropic-messages";
import type { ChatMessage } from "../src/types";
import { ModelHttpError } from "../src/errors";

function anthropicSseResponse(lines: readonly string[]): Response {
  const text = lines.join("\n") + "\n";
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Minimal Anthropic-style stream: text only (matches public SSE examples). */
function fixtureTextOnlyStream(): string[] {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ];
}

/** Text block then tool_use with split JSON deltas. */
function fixtureTextThenToolStream(): string[] {
  return [
    'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[]}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"builtin_read","input":{}}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"a\\"}"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_stop"}',
  ];
}

describe("normalizeAnthropicWireModelId", () => {
  it("strips through the first slash for vendor-prefixed ids", () => {
    assert.equal(normalizeAnthropicWireModelId("acme/auto"), "auto");
    assert.equal(normalizeAnthropicWireModelId("acme/claude-sonnet-4.5"), "claude-sonnet-4.5");
    assert.equal(normalizeAnthropicWireModelId("claude-sonnet-4.5"), "claude-sonnet-4.5");
  });

  it("only removes the first segment when multiple slashes remain", () => {
    assert.equal(normalizeAnthropicWireModelId("org/sub/model"), "sub/model");
  });
});

describe("normalizeAnthropicMessagesOrigin", () => {
  it("strips path to origin for full URL", () => {
    assert.equal(
      normalizeAnthropicMessagesOrigin("https://api.anthropic.com/v1/foo"),
      "https://api.anthropic.com",
    );
  });

  it("keeps host:port origin", () => {
    assert.equal(normalizeAnthropicMessagesOrigin("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  });
});

describe("mapChatMessagesToAnthropicPayload", () => {
  it("joins system messages and maps tool results into one user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tu_1", name: "fn", arguments: '{"x":1}' }],
      },
      { role: "tool", toolCallId: "tu_1", content: "out" },
      { role: "user", content: "next" },
    ];
    const { system, messages: out } = mapChatMessagesToAnthropicPayload(messages);
    assert.equal(system, "A\n\nB");
    assert.equal((out[0] as { role: string }).role, "user");
    assert.equal((out[1] as { role: string }).role, "assistant");
    const userTool = out[2] as { role: string; content: unknown[] };
    assert.equal(userTool.role, "user");
    assert.equal(userTool.content[0]?.type, "tool_result");
    assert.equal((userTool.content[0] as { tool_use_id: string }).tool_use_id, "tu_1");
  });

  it("throws ModelHttpError on invalid tool arguments JSON", () => {
    assert.throws(
      () =>
        mapChatMessagesToAnthropicPayload([
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "1", name: "f", arguments: "not-json{" }],
          },
        ]),
      (e: unknown) => e instanceof ModelHttpError && e.status === 502,
    );
  });

  it("rewrites assistant tool_use names when openAi→Anthropic map is provided", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "builtin.read", description: "d", parameters: { type: "object" as const, properties: {} } },
      },
    ];
    const m = buildOpenAiToAnthropicToolNameMap(tools);
    const { messages: out } = mapChatMessagesToAnthropicPayload(
      [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "x", name: "builtin.read", arguments: "{}" }],
        },
      ],
      m,
    );
    const assistant = out[0] as { content: { type: string; name: string }[] };
    assert.equal(assistant.content[0]?.name, "builtin_read");
  });
});

describe("createAnthropicMessagesProvider", () => {
  it("POSTs /v1/messages with anthropic-version and x-api-key", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: string | undefined;

    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as HeadersInit;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.example",
      apiKey: "sk-ant",
      anthropicVersion: "2023-06-01",
      fetchImpl,
    });

    const out = await p.complete({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.content, "hello");
    assert.match(capturedUrl ?? "", /\/v1\/messages$/);
    const h = new Headers(capturedHeaders);
    assert.equal(h.get("anthropic-version"), "2023-06-01");
    assert.equal(h.get("x-api-key"), "sk-ant");
    assert.ok(capturedBody?.includes("claude-test"));
    assert.ok(capturedBody?.includes('"stream":false'));
  });

  it("complete includes thinking block when thinking.enabled is true", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.example",
      apiKey: "sk-ant",
      fetchImpl,
    });
    await p.complete({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      thinking: { enabled: true, budgetTokens: 1234 },
    });
    const req = JSON.parse(capturedBody ?? "{}") as { thinking?: { type: string; budget_tokens: number } };
    assert.equal(req.thinking?.type, "enabled");
    assert.equal(req.thinking?.budget_tokens, 1234);
  });

  it("complete sends wire model with first namespace segment stripped", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200 },
      );
    };
    const p = createAnthropicMessagesProvider({
      id: "x",
      baseUrl: "https://api.example",
      apiKey: "k",
      fetchImpl,
    });
    await p.complete({ model: "acme/auto", messages: [{ role: "user", content: "h" }] });
    const req = JSON.parse(capturedBody ?? "{}") as { model?: string };
    assert.equal(req.model, "auto");
  });

  it("uses Authorization Bearer when auth is bearer", async () => {
    let authorization: string | null = null;
    let xApiKey: string | null = null;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit);
      authorization = h.get("authorization");
      xApiKey = h.get("x-api-key");
      return new Response(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200 },
      );
    };

    const p = createAnthropicMessagesProvider({
      id: "g",
      baseUrl: "https://gw.example",
      apiKey: "tok",
      auth: "bearer",
      fetchImpl,
    });

    await p.complete({ model: "m", messages: [{ role: "user", content: "x" }] });
    assert.equal(authorization, "Bearer tok");
    assert.equal(xApiKey, null);
  });

  it("completeWithTools maps tools and parses tool_use blocks", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "builtin_read",
              input: { path: "a" },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "read" }],
      tools: [
        {
          type: "function",
          function: {
            name: "builtin.read",
            description: "read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });

    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "builtin.read");
    assert.match(out.toolCalls[0]!.arguments, /"path"\s*:\s*"a"/);
    assert.equal(out.content, null);
    const req = JSON.parse(capturedBody ?? "{}") as { tools?: { name: string }[] };
    assert.equal(req.tools?.[0]?.name, "builtin_read");
  });

  it("completeWithTools omits tools and tool_choice when tools array is empty", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        }),
        { status: 200 },
      );
    };

    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "yo" }],
      tools: [],
    });

    assert.equal(out.toolCalls.length, 0);
    assert.equal(out.content, "hi");
    const req = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    assert.equal("tools" in req, false);
    assert.equal("tool_choice" in req, false);
  });

  it("throws ModelHttpError on non-OK response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });

    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://x.example",
      fetchImpl,
    });

    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) =>
        e instanceof ModelHttpError && e.status === 429 && String(e.bodySnippet).includes("rate"),
    );
  });

  it("complete streams assistant text and sends stream:true", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return anthropicSseResponse(fixtureTextOnlyStream());
    };

    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://api.example",
      fetchImpl,
    });

    const deltas: string[] = [];
    const accumulatedSnapshots: string[] = [];
    const out = await p.complete({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      onTextDelta: (d, acc) => {
        deltas.push(d);
        accumulatedSnapshots.push(acc);
      },
    });

    assert.ok(capturedBody?.includes('"stream":true'));
    assert.equal(out.content, "Hi there");
    assert.deepEqual(deltas, ["Hi ", "there"]);
    assert.deepEqual(accumulatedSnapshots, ["Hi ", "Hi there"]);
  });

  it("completeWithTools streams text, onTextDelta, and split tool input JSON", async () => {
    const fetchImpl = async () => anthropicSseResponse(fixtureTextThenToolStream());

    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const deltas: string[] = [];
    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "read" }],
      tools: [
        {
          type: "function",
          function: {
            name: "builtin.read",
            description: "read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      stream: true,
      onTextDelta: (d) => deltas.push(d),
    });

    assert.equal(out.content, "Checking");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "builtin.read");
    assert.equal(out.toolCalls[0]!.arguments, '{"path":"a"}');
    assert.deepEqual(deltas, ["Checking"]);
  });

  it("complete stream throws when response includes tool_use", async () => {
    const lines = [
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"fn","input":{}}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_stop"}',
    ];
    const p = createAnthropicMessagesProvider({
      id: "a",
      baseUrl: "https://x.example",
      fetchImpl: async () => anthropicSseResponse(lines),
    });

    await assert.rejects(
      () =>
        p.complete({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          stream: true,
        }),
      (e: unknown) =>
        e instanceof ModelHttpError &&
        e.status === 502 &&
        String(e.message).includes("unexpected tool_use"),
    );
  });

  it("consumeAnthropicMessagesStream throws without message_start", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n'));
        c.close();
      },
    });

    await assert.rejects(
      () => consumeAnthropicMessagesStream(body, { accumulateTools: false }),
      (e: unknown) =>
        e instanceof ModelHttpError &&
        e.status === 502 &&
        String(e.message).includes("message_start"),
    );
  });

  it("parses Anthropic SSE when fixture bytes are split across stream chunks", async () => {
    const raw = fixtureTextOnlyStream().join("\n") + "\n";
    const enc = new TextEncoder();
    const mid = Math.floor(raw.length / 2);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(raw.slice(0, mid)));
        c.enqueue(enc.encode(raw.slice(mid)));
        c.close();
      },
    });

    const out = await consumeAnthropicMessagesStream(body, { accumulateTools: false });
    assert.equal(out.content, "Hi there");
    assert.equal(out.toolCalls.length, 0);
  });
});
