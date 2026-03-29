import { describe, it } from "node:test";
import assert from "node:assert";
import { createOpenAICompatibleProvider } from "../src/openai-compatible";
import type { ChatMessage } from "../src/types";
import { ModelHttpError } from "../src/errors";

function sseResponse(lines: readonly string[]): Response {
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

describe("createOpenAICompatibleProvider", () => {
  it("POSTs chat/completions and returns assistant text", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      apiKey: "sk-test",
      fetchImpl,
    });

    const out = await p.complete({
      model: "gpt-test",
      messages,
    });

    assert.equal(out.content, "hello");
    assert.match(capturedUrl ?? "", /chat\/completions$/);
    assert.ok(capturedBody?.includes("gpt-test"));
    assert.ok(capturedBody?.includes("hi"));
  });

  it("throws ModelHttpError on non-OK response", async () => {
    const fetchImpl = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    await assert.rejects(
      () => p.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof ModelHttpError && e.status === 503,
    );
  });

  it("completeWithTools parses tool_calls (non-stream unchanged)", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "builtin.read", arguments: '{"path":"a"}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "gpt-test",
      messages: [{ role: "user", content: "read file" }],
      tools: [
        {
          type: "function",
          function: {
            name: "builtin.read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      stream: false,
    });

    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "builtin.read");
    assert.match(out.toolCalls[0]!.arguments, /a/);
  });

  it("completeWithTools streams text-only and invokes onTextDelta", async () => {
    let capturedBody: string | undefined;
    const deltas: string[] = [];
    const accumulatedSnapshots: string[] = [];

    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi "}}]}',
        'data: {"choices":[{"delta":{"content":"there"}}]}',
        "data: [DONE]",
      ]);
    };

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "gpt-test",
      messages: [{ role: "user", content: "say hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "noop",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      stream: true,
      onTextDelta: (d, acc) => {
        deltas.push(d);
        accumulatedSnapshots.push(acc);
      },
    });

    assert.ok(capturedBody?.includes('"stream":true'));
    assert.equal(out.content, "Hi there");
    assert.equal(out.toolCalls.length, 0);
    assert.deepEqual(deltas, ["Hi ", "there"]);
    assert.deepEqual(accumulatedSnapshots, ["Hi ", "Hi there"]);
  });

  it("completeWithTools streams split tool_calls arguments", async () => {
    const fetchImpl = async () =>
      sseResponse([
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "builtin.read" },
                    },
                  ],
                },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
                },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }],
                },
              },
            ],
          }),
        "data: [DONE]",
      ]);

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "gpt-test",
      messages: [{ role: "user", content: "read" }],
      tools: [
        {
          type: "function",
          function: {
            name: "builtin.read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      stream: true,
    });

    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.id, "call_1");
    assert.equal(out.toolCalls[0]!.name, "builtin.read");
    assert.equal(out.toolCalls[0]!.arguments, '{"path":"a"}');
    assert.equal(out.content, null);
  });

  it("complete streams assistant text", async () => {
    const fetchImpl = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"x"}}]}',
        'data: {"choices":[{"delta":{"content":"y"}}]}',
        "data: [DONE]",
      ]);

    const p = createOpenAICompatibleProvider({
      id: "p1",
      baseUrl: "https://api.example/v1",
      fetchImpl,
    });

    const nCalls = { n: 0 };
    const out = await p.complete({
      model: "m",
      messages: [{ role: "user", content: "p" }],
      stream: true,
      onTextDelta: () => {
        nCalls.n += 1;
      },
    });

    assert.equal(out.content, "xy");
    assert.equal(nCalls.n, 2);
  });
});
