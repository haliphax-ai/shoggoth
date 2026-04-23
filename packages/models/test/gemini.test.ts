import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import {
  createGeminiProvider,
  mapChatMessagesToGeminiPayload,
  consumeGeminiStream,
  sanitizeSchemaForGemini,
} from "../src/gemini";
import type { ChatMessage } from "../src/types";
import { ModelHttpError } from "../src/errors";
import { setResilienceGate, ModelResilienceGate } from "../src/resilience";

// Disable retries so error tests don't wait on real backoff delays
beforeEach(() => {
  setResilienceGate(new ModelResilienceGate({ maxRetries: 0 }));
});

// ---------------------------------------------------------------------------
// Mock response helpers
// ---------------------------------------------------------------------------

function geminiTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }],
  };
}

function geminiToolCallResponse(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
) {
  return {
    candidates: [
      {
        content: {
          parts: calls.map((c) => ({
            functionCall: {
              name: c.name,
              args: c.args,
              ...(c.id ? { id: c.id } : {}),
            },
          })),
          role: "model",
        },
        finishReason: "STOP",
      },
    ],
  };
}

function geminiMixedResponse(
  text: string,
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
) {
  return {
    candidates: [
      {
        content: {
          parts: [
            { text },
            ...calls.map((c) => ({
              functionCall: {
                name: c.name,
                args: c.args,
                ...(c.id ? { id: c.id } : {}),
              },
            })),
          ],
          role: "model",
        },
        finishReason: "STOP",
      },
    ],
  };
}

function geminiSafetyBlockedResponse() {
  return { candidates: [{ finishReason: "SAFETY" }] };
}

function sseResponse(chunks: readonly string[]): Response {
  const text = chunks.map((c) => `data: ${c}\n\n`).join("");
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

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${c}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Message mapping
// ---------------------------------------------------------------------------

describe("mapChatMessagesToGeminiPayload", () => {
  it("extracts system messages into systemInstruction", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "system", content: "Be concise" },
      { role: "user", content: "hi" },
    ];
    const { systemInstruction, contents } = mapChatMessagesToGeminiPayload(messages);
    assert.deepStrictEqual(systemInstruction, {
      parts: [{ text: "You are helpful" }, { text: "Be concise" }],
    });
    assert.equal(contents.length, 1);
  });

  it("returns no systemInstruction when no system messages", () => {
    const { systemInstruction } = mapChatMessagesToGeminiPayload([{ role: "user", content: "hi" }]);
    assert.equal(systemInstruction, undefined);
  });

  it("maps user messages to role user with text parts", () => {
    const { contents } = mapChatMessagesToGeminiPayload([{ role: "user", content: "hello" }]);
    assert.deepStrictEqual(contents[0], {
      role: "user",
      parts: [{ text: "hello" }],
    });
  });

  it("maps assistant messages to role model with text parts", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "assistant", content: "hi there" },
    ]);
    assert.deepStrictEqual(contents[0], {
      role: "model",
      parts: [{ text: "hi there" }],
    });
  });

  it("maps assistant messages with tool calls to functionCall parts", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a.txt"}' }],
      },
    ]);
    const turn = contents[0] as { role: string; parts: unknown[] };
    assert.equal(turn.role, "model");
    assert.deepStrictEqual(turn.parts[0], {
      functionCall: { name: "read", args: { path: "a.txt" } },
    });
  });

  it("batches consecutive tool messages into a single tool turn", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", toolCallId: "c1", name: "read", content: '{"data":"x"}' },
      { role: "tool", toolCallId: "c2", name: "write", content: '{"ok":true}' },
    ]);
    assert.equal(contents.length, 1);
    const turn = contents[0] as { role: string; parts: unknown[] };
    assert.equal(turn.role, "tool");
    assert.equal(turn.parts.length, 2);
  });

  it("parses valid JSON tool content into response object", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: '{"key":"val"}' },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, { key: "val" });
  });

  it("wraps non-JSON tool content as { result: content }", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: "plain text output" },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, {
      result: "plain text output",
    });
  });

  it("wraps array JSON tool content as { result: array }", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: "[1, 2, 3]" },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, {
      result: [1, 2, 3],
    });
  });

  it("wraps primitive JSON tool content as { result: primitive }", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: "42" },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, { result: 42 });
  });

  it("wraps null JSON tool content as { result: null }", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: "null" },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, { result: null });
  });

  it("wraps string JSON tool content as { result: string }", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "tool", name: "fn", content: '"just a string"' },
    ]);
    const turn = contents[0] as { parts: Array<{ functionResponse: { response: unknown } }> };
    assert.deepStrictEqual(turn.parts[0]!.functionResponse.response, { result: "just a string" });
  });

  it("handles empty/null content on user messages", () => {
    const { contents } = mapChatMessagesToGeminiPayload([
      { role: "user", content: null },
      { role: "user", content: "" },
    ]);
    const t0 = contents[0] as { parts: Array<{ text: string }> };
    const t1 = contents[1] as { parts: Array<{ text: string }> };
    assert.equal(t0.parts[0]!.text, "");
    assert.equal(t1.parts[0]!.text, "");
  });

  it("handles assistant with no content and no tool calls (empty text part)", () => {
    const { contents } = mapChatMessagesToGeminiPayload([{ role: "assistant", content: null }]);
    const turn = contents[0] as { role: string; parts: Array<{ text: string }> };
    assert.equal(turn.role, "model");
    assert.deepStrictEqual(turn.parts, [{ text: "" }]);
  });

  it("skips system messages with empty content", () => {
    const { systemInstruction } = mapChatMessagesToGeminiPayload([
      { role: "system", content: "" },
      { role: "system", content: null },
      { role: "user", content: "hi" },
    ]);
    assert.equal(systemInstruction, undefined);
  });
});

// ---------------------------------------------------------------------------
// 1b. sanitizeSchemaForGemini
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForGemini", () => {
  it("removes additionalProperties", () => {
    const result = sanitizeSchemaForGemini({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }) as Record<string, unknown>;
    assert.equal("additionalProperties" in result, false);
  });

  it("converts const to single-element string enum", () => {
    const result = sanitizeSchemaForGemini({
      type: "string",
      const: "fixed_value",
    }) as Record<string, unknown>;
    assert.deepStrictEqual(result.enum, ["fixed_value"]);
    assert.equal("const" in result, false);
  });

  it("converts numeric const to string enum", () => {
    const result = sanitizeSchemaForGemini({
      type: "number",
      const: 42,
    }) as Record<string, unknown>;
    assert.deepStrictEqual(result.enum, ["42"]);
    assert.equal("const" in result, false);
  });

  it("coerces numeric enum values to strings", () => {
    const result = sanitizeSchemaForGemini({
      type: "integer",
      enum: [60, 1440, 4320, 10080],
    }) as Record<string, unknown>;
    assert.deepStrictEqual(result.enum, ["60", "1440", "4320", "10080"]);
  });

  it("coerces mixed enum values to strings", () => {
    const result = sanitizeSchemaForGemini({
      enum: ["a", 2, true],
    }) as Record<string, unknown>;
    assert.deepStrictEqual(result.enum, ["a", "2", "true"]);
  });

  it("recursively sanitizes nested properties", () => {
    const result = sanitizeSchemaForGemini({
      type: "object",
      properties: {
        inner: {
          type: "object",
          additionalProperties: true,
          properties: {
            val: { type: "number", const: 5 },
          },
        },
      },
    }) as Record<string, unknown>;
    const inner = (result.properties as Record<string, unknown>).inner as Record<string, unknown>;
    assert.equal("additionalProperties" in inner, false);
    const val = (inner.properties as Record<string, unknown>).val as Record<string, unknown>;
    assert.deepStrictEqual(val.enum, ["5"]);
    assert.equal("const" in val, false);
  });

  it("sanitizes items in array schemas", () => {
    const result = sanitizeSchemaForGemini({
      type: "array",
      items: { type: "string", additionalProperties: false },
    }) as Record<string, unknown>;
    const items = result.items as Record<string, unknown>;
    assert.equal("additionalProperties" in items, false);
  });

  it("sanitizes oneOf/anyOf/allOf variants", () => {
    const result = sanitizeSchemaForGemini({
      oneOf: [
        { type: "string", const: "a" },
        { type: "number", enum: [1, 2] },
      ],
      anyOf: [{ additionalProperties: true, type: "object" }],
      allOf: [{ const: "x" }],
    }) as Record<string, unknown>;
    const oneOf = result.oneOf as Array<Record<string, unknown>>;
    assert.deepStrictEqual(oneOf[0].enum, ["a"]);
    assert.equal("const" in oneOf[0], false);
    assert.deepStrictEqual(oneOf[1].enum, ["1", "2"]);
    const anyOf = result.anyOf as Array<Record<string, unknown>>;
    assert.equal("additionalProperties" in anyOf[0], false);
    const allOf = result.allOf as Array<Record<string, unknown>>;
    assert.deepStrictEqual(allOf[0].enum, ["x"]);
  });

  it("passes through null/primitive/array schema unchanged", () => {
    assert.equal(sanitizeSchemaForGemini(null), null);
    assert.equal(sanitizeSchemaForGemini(undefined), undefined);
    assert.equal(sanitizeSchemaForGemini("string"), "string");
    const arr = [1, 2];
    assert.strictEqual(sanitizeSchemaForGemini(arr), arr);
  });

  it("leaves already-clean schemas untouched", () => {
    const clean = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer", enum: ["1", "2", "3"] },
      },
    };
    const result = sanitizeSchemaForGemini(clean) as Record<string, unknown>;
    assert.equal(result.type, "object");
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(props.count.enum, ["1", "2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Non-streaming complete()
// ---------------------------------------------------------------------------

describe("createGeminiProvider complete()", () => {
  it("returns text content from candidates", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiTextResponse("hello world")), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.complete({
      model: "gemini-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.content, "hello world");
  });

  it("rejects unexpected functionCall parts", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiToolCallResponse([{ name: "fn", args: {} }])), {
        status: 200,
      });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) =>
        e instanceof ModelHttpError &&
        e.status === 502 &&
        String(e.message).includes("unexpected functionCall"),
    );
  });

  it("throws ModelHttpError on HTTP 4xx", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        statusText: "Bad Request",
      });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof ModelHttpError && e.status === 400,
    );
  });

  it("throws ModelHttpError on HTTP 5xx", async () => {
    const fetchImpl = async () =>
      new Response("internal error", { status: 500, statusText: "Internal Server Error" });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof ModelHttpError && e.status === 500,
    );
  });

  it("throws ModelHttpError on safety-blocked response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiSafetyBlockedResponse()), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) =>
        e instanceof ModelHttpError && e.status === 400 && String(e.message).includes("safety"),
    );
  });

  it("throws ModelHttpError on malformed JSON response", async () => {
    const fetchImpl = async () => new Response("not json at all{{{", { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) =>
        e instanceof ModelHttpError &&
        e.status === 502 &&
        String(e.message).includes("invalid JSON"),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Non-streaming completeWithTools()
// ---------------------------------------------------------------------------

describe("createGeminiProvider completeWithTools()", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  it("returns text-only response (no tool calls)", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiTextResponse("just text")), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "hi" }],
      tools,
    });
    assert.equal(out.content, "just text");
    assert.equal(out.toolCalls.length, 0);
  });

  it("returns tool calls from functionCall parts", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify(geminiToolCallResponse([{ name: "read_file", args: { path: "a.txt" } }])),
        { status: 200 },
      );

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "read" }],
      tools,
    });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "read_file");
    assert.equal(out.toolCalls[0]!.arguments, '{"path":"a.txt"}');
  });

  it("returns both text and tool calls in mixed response", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify(
          geminiMixedResponse("Let me check", [{ name: "read_file", args: { path: "b.txt" } }]),
        ),
        { status: 200 },
      );

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "read" }],
      tools,
    });
    assert.equal(out.content, "Let me check");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "read_file");
  });

  it("passes through function call ID when present", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify(
          geminiToolCallResponse([{ name: "read_file", args: { path: "c.txt" }, id: "my-id-123" }]),
        ),
        { status: 200 },
      );

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "read" }],
      tools,
    });
    assert.equal(out.toolCalls[0]!.id, "my-id-123");
  });

  it("synthesizes function call ID as gemini-call-{index} when absent", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify(
          geminiToolCallResponse([
            { name: "read_file", args: { path: "a" } },
            { name: "read_file", args: { path: "b" } },
          ]),
        ),
        { status: 200 },
      );

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "read" }],
      tools,
    });
    assert.equal(out.toolCalls[0]!.id, "gemini-call-0");
    assert.equal(out.toolCalls[1]!.id, "gemini-call-1");
  });

  it("throws on safety-blocked response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiSafetyBlockedResponse()), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          tools,
        }),
      (e: unknown) =>
        e instanceof ModelHttpError && e.status === 400 && String(e.message).includes("safety"),
    );
  });

  it("sanitizes tool parameters before sending to Gemini", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const dirtyTools = [
      {
        type: "function" as const,
        function: {
          name: "test_tool",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: { type: "string", const: "auto" },
              timeout: { type: "integer", enum: [60, 1440] },
            },
          },
        },
      },
    ];

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await p.completeWithTools({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: dirtyTools,
    });

    const body = JSON.parse(capturedBody ?? "{}") as {
      tools?: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    };
    const params = body.tools?.[0]?.functionDeclarations[0]?.parameters;
    assert.ok(params);
    assert.equal("additionalProperties" in params!, false);
    const props = params!.properties as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(props.mode.enum, ["auto"]);
    assert.equal("const" in props.mode, false);
    assert.deepStrictEqual(props.timeout.enum, ["60", "1440"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Streaming complete() (via consumeGeminiStream)
// ---------------------------------------------------------------------------

describe("streaming complete()", () => {
  it("accumulates text chunks and fires onTextDelta", async () => {
    const fetchImpl = async () =>
      sseResponse([
        JSON.stringify(geminiTextResponse("Hello ")),
        JSON.stringify(geminiTextResponse("world")),
      ]);

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const deltas: string[] = [];
    const accumulated: string[] = [];
    const out = await p.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      onTextDelta: (d, acc) => {
        deltas.push(d);
        accumulated.push(acc);
      },
    });
    assert.equal(out.content, "Hello world");
    assert.deepStrictEqual(deltas, ["Hello ", "world"]);
    assert.deepStrictEqual(accumulated, ["Hello ", "Hello world"]);
  });

  it("rejects unexpected tool calls in non-tool streaming", async () => {
    const fetchImpl = async () =>
      sseResponse([JSON.stringify(geminiToolCallResponse([{ name: "fn", args: {} }]))]);

    const p = createGeminiProvider({ id: "g", fetchImpl });
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
        String(e.message).includes("unexpected functionCall"),
    );
  });

  it("handles empty stream (throws missing content)", async () => {
    const fetchImpl = async () => sseResponse([JSON.stringify({ candidates: [] })]);

    const p = createGeminiProvider({ id: "g", fetchImpl });
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
        String(e.message).includes("missing streamed assistant content"),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Streaming completeWithTools()
// ---------------------------------------------------------------------------

describe("streaming completeWithTools()", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  it("streams text with tool calls", async () => {
    const fetchImpl = async () =>
      sseResponse([
        JSON.stringify(geminiTextResponse("Checking")),
        JSON.stringify(geminiToolCallResponse([{ name: "read_file", args: { path: "x" } }])),
      ]);

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const deltas: string[] = [];
    const out = await p.completeWithTools({
      model: "m",
      messages: [{ role: "user", content: "read" }],
      tools,
      stream: true,
      onTextDelta: (d) => deltas.push(d),
    });
    assert.equal(out.content, "Checking");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "read_file");
    assert.deepStrictEqual(deltas, ["Checking"]);
  });

  it("accumulates tool calls across chunks", async () => {
    const fetchImpl = async () =>
      sseResponse([
        JSON.stringify(geminiToolCallResponse([{ name: "read_file", args: { path: "a" } }])),
        JSON.stringify(geminiToolCallResponse([{ name: "read_file", args: { path: "b" } }])),
      ]);

    const p = createGeminiProvider({ id: "g", fetchImpl });
    const out = await p.completeWithTools({
      model: "m",
      messages: [{ role: "user", content: "read" }],
      tools,
      stream: true,
    });
    assert.equal(out.toolCalls.length, 2);
    assert.equal(out.toolCalls[0]!.id, "gemini-call-0");
    assert.equal(out.toolCalls[1]!.id, "gemini-call-1");
    assert.equal(out.toolCalls[0]!.arguments, '{"path":"a"}');
    assert.equal(out.toolCalls[1]!.arguments, '{"path":"b"}');
  });
});

// ---------------------------------------------------------------------------
// 6. Provider factory (createGeminiProvider)
// ---------------------------------------------------------------------------

describe("createGeminiProvider factory", () => {
  it("constructs correct non-streaming URL", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string | URL, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({
      id: "g",
      baseUrl: "https://api.example.com",
      apiVersion: "v1",
      fetchImpl,
    });
    await p.complete({ model: "gemini-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(capturedUrl, "https://api.example.com/v1/models/gemini-pro:generateContent");
  });

  it("constructs correct streaming URL", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string | URL, _init?: RequestInit) => {
      capturedUrl = String(url);
      return sseResponse([JSON.stringify(geminiTextResponse("ok"))]);
    };

    const p = createGeminiProvider({
      id: "g",
      baseUrl: "https://api.example.com",
      apiVersion: "v1",
      fetchImpl,
    });
    await p.complete({
      model: "gemini-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(
      capturedUrl,
      "https://api.example.com/v1/models/gemini-pro:streamGenerateContent?alt=sse",
    );
  });

  it("sets x-goog-api-key header", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as HeadersInit;
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({
      id: "g",
      apiKey: "my-secret-key",
      fetchImpl,
    });
    await p.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const h = new Headers(capturedHeaders);
    assert.equal(h.get("x-goog-api-key"), "my-secret-key");
  });

  it("applies default baseUrl and apiVersion when not specified", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string | URL, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await p.complete({ model: "gemini-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(
      capturedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
    );
  });

  it("populates generationConfig from maxOutputTokens and temperature", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await p.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 1024,
      temperature: 0.7,
    });
    const body = JSON.parse(capturedBody ?? "{}") as {
      generationConfig?: { maxOutputTokens?: number; temperature?: number };
    };
    assert.equal(body.generationConfig?.maxOutputTokens, 1024);
    assert.equal(body.generationConfig?.temperature, 0.7);
  });

  it("shallow-merges requestExtras into body", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });
    await p.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      requestExtras: {
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS", threshold: "BLOCK_NONE" }],
      },
    });
    const body = JSON.parse(capturedBody ?? "{}") as {
      safetySettings?: unknown[];
    };
    assert.ok(Array.isArray(body.safetySettings));
    assert.equal(body.safetySettings!.length, 1);
  });

  it("strips trailing slashes from baseUrl", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (url: string | URL, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(geminiTextResponse("ok")), { status: 200 });
    };

    const p = createGeminiProvider({
      id: "g",
      baseUrl: "https://api.example.com///",
      apiVersion: "v1",
      fetchImpl,
    });
    await p.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.ok(capturedUrl?.startsWith("https://api.example.com/v1/"));
  });
});

// ---------------------------------------------------------------------------
// consumeGeminiStream direct tests
// ---------------------------------------------------------------------------

describe("consumeGeminiStream", () => {
  it("handles safety block in stream", async () => {
    const body = sseBody([JSON.stringify(geminiSafetyBlockedResponse())]);
    await assert.rejects(
      () => consumeGeminiStream(body, { accumulateTools: false }),
      (e: unknown) =>
        e instanceof ModelHttpError && e.status === 400 && String(e.message).includes("safety"),
    );
  });

  it("handles malformed SSE data JSON", async () => {
    const body = sseBody(["not valid json{{"]);
    await assert.rejects(
      () => consumeGeminiStream(body, { accumulateTools: false }),
      (e: unknown) =>
        e instanceof ModelHttpError && e.status === 502 && String(e.message).includes("malformed"),
    );
  });
});

describe("mapChatMessagesToGeminiPayload with ChatContentPart[]", () => {
  it("serializes user message with mixed text + image content parts", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", mediaType: "image/png", base64: "iVBOR" },
        ],
      },
    ];
    const { contents } = mapChatMessagesToGeminiPayload(messages);
    const user = contents[0] as { role: string; parts: unknown[] };
    assert.equal(user.role, "user");
    assert.equal(user.parts.length, 2);
    assert.deepStrictEqual(user.parts[0], { text: "What is in this image?" });
    assert.deepStrictEqual(user.parts[1], {
      inlineData: { mimeType: "image/png", data: "iVBOR" },
    });
  });

  it("serializes user message with multiple images", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these" },
          { type: "image", mediaType: "image/jpeg", base64: "abc" },
          { type: "image", mediaType: "image/webp", base64: "def" },
        ],
      },
    ];
    const { contents } = mapChatMessagesToGeminiPayload(messages);
    const user = contents[0] as { role: string; parts: unknown[] };
    assert.equal(user.parts.length, 3);
    assert.deepStrictEqual(user.parts[1], {
      inlineData: { mimeType: "image/jpeg", data: "abc" },
    });
    assert.deepStrictEqual(user.parts[2], {
      inlineData: { mimeType: "image/webp", data: "def" },
    });
  });

  it("plain string user content still serializes identically", () => {
    const { contents } = mapChatMessagesToGeminiPayload([{ role: "user", content: "hello" }]);
    assert.deepStrictEqual(contents[0], {
      role: "user",
      parts: [{ text: "hello" }],
    });
  });
});
