import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { createOpenAICompatibleProvider } from "../src/openai-compatible";
import { StructuredOutputValidationError } from "../src/response-validation";
import { setResilienceGate, ModelResilienceGate } from "../src/resilience";

// Disable retries so error tests don't wait on real backoff delays
beforeEach(() => {
  setResilienceGate(new ModelResilienceGate({ maxRetries: 0 }));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "number" },
  },
  required: ["name", "count"],
  additionalProperties: false,
};

const RESPONSE_SCHEMA = { schema: TEST_SCHEMA };

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

function okJsonResponse(content: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200 },
  );
}

function okToolCallResponse(calls: Array<{ id: string; name: string; arguments: string }>) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          },
        },
      ],
    }),
    { status: 200 },
  );
}

/** Build a synthetic __structured_output__ tool call with the given arguments JSON. */
function syntheticCallResponse(argsJson: string) {
  return okToolCallResponse([
    { id: "call_synthetic", name: "__structured_output__", arguments: argsJson },
  ]);
}

/** Build a response with a real tool call. */
function realToolCallResponse() {
  return okToolCallResponse([
    { id: "call_read", name: "read_file", arguments: JSON.stringify({ path: "/tmp/test" }) },
  ]);
}

// ---------------------------------------------------------------------------
// Structured output: strict mode (OpenAI ceiling = "strict")
// ---------------------------------------------------------------------------

describe("OpenAI structured output — strict mode", () => {
  it("completeWithTools injects synthetic __structured_output__ tool instead of response_format", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      // Respond with a synthetic tool call so the provider extracts it
      return syntheticCallResponse(conformantJson);
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "strict",
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;

    // response_format should NOT be set (synthetic tool replaces it)
    assert.equal(
      body.response_format,
      undefined,
      "response_format should NOT be present — synthetic tool replaces it",
    );

    // Synthetic __structured_output__ tool should be in the tools array
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    assert.ok(tools, "tools should be present");
    const syntheticTool = tools.find((t) => t.function.name === "__structured_output__");
    assert.ok(syntheticTool, "__structured_output__ synthetic tool should be in tools");
    assert.equal(syntheticTool!.type, "function");
  });

  it("complete includes response_format with strict: true when responseSchema is set (default mode)", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Bob", count: 10 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return okJsonResponse(conformantJson);
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    // No explicit structuredOutputMode — should default to adapter ceiling "strict"
    await p.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const rf = body.response_format as {
      type: string;
      json_schema: { name: string; schema: unknown; strict: boolean };
    };
    assert.ok(rf, "response_format should be present in request body");
    assert.equal(rf.type, "json_schema");
    assert.equal(rf.json_schema.strict, true);
  });

  it("strict mode does NOT throw on conformant response (no post-validation)", async () => {
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async () => syntheticCallResponse(conformantJson);

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    // Should not throw — strict mode trusts the provider
    const out = await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "strict",
    });
    assert.ok(out.content);
    assert.equal(out.content, conformantJson);
  });

  it("real tool calls work alongside synthetic tool, synthetic gets stripped", async () => {
    const fetchImpl = async () => realToolCallResponse();

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "read a file" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "strict",
    });

    assert.ok(out.toolCalls);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "read_file");
  });
});

// ---------------------------------------------------------------------------
// Structured output: best-effort mode
// ---------------------------------------------------------------------------

describe("OpenAI structured output — best-effort mode", () => {
  it("injects synthetic tool when mode is best-effort", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return syntheticCallResponse(conformantJson);
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "best-effort",
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    assert.equal(
      body.response_format,
      undefined,
      "response_format should NOT be present — synthetic tool replaces it",
    );
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    const syntheticTool = tools.find((t) => t.function.name === "__structured_output__");
    assert.ok(syntheticTool, "__structured_output__ synthetic tool should be in tools");
  });

  it("best-effort mode throws StructuredOutputValidationError on non-conformant synthetic response", async () => {
    // Missing required "count" field
    const nonConformantJson = JSON.stringify({ name: "Alice" });
    let callCount = 0;
    const fetchImpl = async (_url: string | URL, _init?: RequestInit) => {
      callCount++;
      // First call: model responds with text (no tool calls) — forces follow-up
      if (callCount === 1) {
        return okJsonResponse(nonConformantJson);
      }
      // Follow-up call: model responds with a synthetic tool call containing non-conformant JSON
      return syntheticCallResponse(nonConformantJson);
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "gpt-4o",
          messages: [{ role: "user", content: "give me data" }],
          tools: TOOLS,
          responseSchema: RESPONSE_SCHEMA,
          structuredOutputMode: "best-effort",
        }),
      (e: unknown) => {
        assert.ok(
          e instanceof StructuredOutputValidationError,
          `expected StructuredOutputValidationError, got ${(e as Error).constructor.name}`,
        );
        assert.equal(e.rawContent, nonConformantJson);
        assert.deepStrictEqual(e.schema, TEST_SCHEMA);
        return true;
      },
    );
  });

  it("best-effort mode does NOT throw on conformant response", async () => {
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async () => syntheticCallResponse(conformantJson);

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "best-effort",
    });
    assert.ok(out.content);
    assert.equal(out.content, conformantJson);
  });

  it("best-effort post-validation also works in complete() (non-tool path)", async () => {
    const nonConformantJson = JSON.stringify({ name: "Alice" });
    const fetchImpl = async () => okJsonResponse(nonConformantJson);

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await assert.rejects(
      () =>
        p.complete({
          model: "gpt-4o",
          messages: [{ role: "user", content: "give me data" }],
          responseSchema: RESPONSE_SCHEMA,
          structuredOutputMode: "best-effort",
        }),
      (e: unknown) => e instanceof StructuredOutputValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Structured output: mode "none"
// ---------------------------------------------------------------------------

describe("OpenAI structured output — mode none", () => {
  it("does NOT include response_format or synthetic tool when mode is none", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return okJsonResponse("just text");
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "none",
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    assert.equal(
      body.response_format,
      undefined,
      "response_format should NOT be present when mode is none",
    );
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    const syntheticTool = tools.find((t) => t.function.name === "__structured_output__");
    assert.equal(
      syntheticTool,
      undefined,
      "synthetic tool should NOT be present when mode is none",
    );
  });
});

// ---------------------------------------------------------------------------
// Structured output: responseSchema absent
// ---------------------------------------------------------------------------

describe("OpenAI structured output — no responseSchema", () => {
  it("does NOT include response_format or synthetic tool when responseSchema is absent regardless of mode", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return okJsonResponse("just text");
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      // No responseSchema
      structuredOutputMode: "strict",
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    assert.equal(
      body.response_format,
      undefined,
      "response_format should NOT be present when responseSchema is absent",
    );
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    const syntheticTool = tools.find((t) => t.function.name === "__structured_output__");
    assert.equal(
      syntheticTool,
      undefined,
      "synthetic tool should NOT be present when responseSchema is absent",
    );
    // Original tools should still be there
    assert.equal(tools.length, TOOLS.length);
  });

  it("does NOT include response_format when neither responseSchema nor mode is set", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return okJsonResponse("just text");
    };

    const p = createOpenAICompatibleProvider({
      id: "oai",
      baseUrl: "https://api.openai.com/v1",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    assert.equal(body.response_format, undefined);
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    assert.equal(tools.length, TOOLS.length);
  });
});
