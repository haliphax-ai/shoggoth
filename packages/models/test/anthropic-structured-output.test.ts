import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { createAnthropicMessagesProvider } from "../src/anthropic-messages";
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

/** Build a non-streaming Anthropic JSON response with the given content blocks. */
function anthropicJsonResponse(contentBlocks: unknown[]) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: contentBlocks,
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Build a response containing only a synthetic tool call with the given arguments. */
function syntheticToolOnlyResponse(args: Record<string, unknown>) {
  return anthropicJsonResponse([
    {
      type: "tool_use",
      id: "toolu_synth_1",
      name: "__structured_output__",
      input: args,
    },
  ]);
}

/** Build a response containing both a synthetic tool call and a real tool call. */
function mixedToolResponse(
  syntheticArgs: Record<string, unknown>,
  realToolName: string,
  realToolArgs: Record<string, unknown>,
) {
  return anthropicJsonResponse([
    { type: "text", text: "Let me help." },
    {
      type: "tool_use",
      id: "toolu_real_1",
      name: realToolName,
      input: realToolArgs,
    },
    {
      type: "tool_use",
      id: "toolu_synth_1",
      name: "__structured_output__",
      input: syntheticArgs,
    },
  ]);
}

/** Build a text-only response (no tool calls). */
function textOnlyResponse(text: string) {
  return anthropicJsonResponse([{ type: "text", text }]);
}

// ---------------------------------------------------------------------------
// 1. Synthetic tool injection
// ---------------------------------------------------------------------------

describe("Anthropic structured output — synthetic tool injection", () => {
  it("injects __structured_output__ tool into the tools list when responseSchema is set", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return syntheticToolOnlyResponse({ name: "Alice", count: 5 });
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as {
      tools?: { name: string; input_schema?: unknown }[];
    };
    assert.ok(body.tools, "tools should be present in request body");
    const syntheticTool = body.tools.find((t) => t.name === "__structured_output__");
    assert.ok(
      syntheticTool,
      "synthetic __structured_output__ tool should be injected into tools list",
    );
    assert.deepStrictEqual(
      syntheticTool.input_schema,
      TEST_SCHEMA,
      "synthetic tool input_schema should match the responseSchema.schema",
    );
  });

  it("preserves real tools alongside the synthetic tool", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return syntheticToolOnlyResponse({ name: "Alice", count: 5 });
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as { tools?: { name: string }[] };
    assert.ok(body.tools, "tools should be present");
    const toolNames = body.tools.map((t) => t.name);
    assert.ok(toolNames.includes("read_file"), "real tool should still be present");
    assert.ok(toolNames.includes("__structured_output__"), "synthetic tool should be present");
    assert.equal(body.tools.length, 2, "should have real tool + synthetic tool");
  });
});

// ---------------------------------------------------------------------------
// 2. Terminal detection (synthetic-only)
// ---------------------------------------------------------------------------

describe("Anthropic structured output — terminal detection (synthetic-only)", () => {
  it("extracts synthetic tool arguments as response content and returns empty toolCalls", async () => {
    const structuredData = { name: "Alice", count: 5 };
    const fetchImpl = async () => syntheticToolOnlyResponse(structuredData);

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    // The synthetic tool call should be treated as terminal: content is the JSON arguments,
    // and toolCalls should be empty (no real tool calls to execute).
    assert.equal(
      out.toolCalls.length,
      0,
      "toolCalls should be empty when only synthetic tool is called",
    );
    assert.ok(out.content, "content should contain the structured output");
    const parsed = JSON.parse(out.content!);
    assert.deepStrictEqual(
      parsed,
      structuredData,
      "content should be the synthetic tool arguments as JSON",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Mixed response (synthetic + real tools)
// ---------------------------------------------------------------------------

describe("Anthropic structured output — mixed response", () => {
  it("strips synthetic tool call and returns only real tool calls", async () => {
    const fetchImpl = async () =>
      mixedToolResponse({ name: "Alice", count: 5 }, "read_file", { path: "/tmp/test.txt" });

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    // The synthetic call should be stripped; only the real tool call should remain.
    assert.equal(out.toolCalls.length, 1, "should have exactly 1 real tool call");
    assert.equal(
      out.toolCalls[0]!.name,
      "read_file",
      "the remaining tool call should be the real one",
    );
    // The synthetic tool call (__structured_output__) should NOT appear in toolCalls
    const syntheticCall = out.toolCalls.find((tc) => tc.name === "__structured_output__");
    assert.equal(syntheticCall, undefined, "synthetic tool call should be stripped from toolCalls");
  });
});

// ---------------------------------------------------------------------------
// 4. Text-only response with schema → forced follow-up
// ---------------------------------------------------------------------------

describe("Anthropic structured output — text-only response forces follow-up", () => {
  it("forces a follow-up call with tool_choice targeting synthetic tool when model produces text-only", async () => {
    let callCount = 0;
    let secondCallBody: string | undefined;
    const structuredData = { name: "Bob", count: 10 };

    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: model returns text only, no tool calls
        return textOnlyResponse("Here is some analysis about the data.");
      }
      // Second call: forced follow-up should target the synthetic tool
      secondCallBody = init?.body as string;
      return syntheticToolOnlyResponse(structuredData);
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    // Should have made a second call to force the synthetic tool
    assert.equal(
      callCount,
      2,
      "should make a follow-up call when model returns text-only with responseSchema",
    );

    // The follow-up call should use tool_choice targeting the synthetic tool
    const body = JSON.parse(secondCallBody ?? "{}") as {
      tool_choice?: { type: string; name?: string };
    };
    assert.ok(body.tool_choice, "follow-up call should include tool_choice");
    assert.equal(body.tool_choice.type, "tool", "tool_choice type should be 'tool'");
    assert.equal(
      body.tool_choice.name,
      "__structured_output__",
      "tool_choice should target __structured_output__",
    );

    // Final output should be the structured data
    assert.equal(out.toolCalls.length, 0, "toolCalls should be empty after forced follow-up");
    assert.ok(out.content, "content should contain the structured output");
    const parsed = JSON.parse(out.content!);
    assert.deepStrictEqual(parsed, structuredData);
  });

  it("throws when the forced follow-up also returns text (text is never accepted as structured output)", async () => {
    const textAnswer = "Here is some analysis about the data.";
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return textOnlyResponse(textAnswer);
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "claude-3",
          messages: [{ role: "user", content: "give me data" }],
          tools: TOOLS,
          responseSchema: RESPONSE_SCHEMA,
        }),
      (e: unknown) => {
        assert.ok(
          e instanceof StructuredOutputValidationError,
          `expected StructuredOutputValidationError, got ${(e as Error).constructor.name}`,
        );
        assert.match((e as Error).message, /__structured_output__/);
        assert.equal(e.rawContent, textAnswer);
        assert.equal(callCount, 2, "initial call plus forced follow-up");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Post-validation: non-conformant synthetic tool arguments
// ---------------------------------------------------------------------------

describe("Anthropic structured output — post-validation", () => {
  it("throws StructuredOutputValidationError when synthetic tool arguments do not conform to schema", async () => {
    // Missing required "count" field
    const nonConformantData = { name: "Alice" };
    const fetchImpl = async () => syntheticToolOnlyResponse(nonConformantData);

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "claude-3",
          messages: [{ role: "user", content: "give me data" }],
          tools: TOOLS,
          responseSchema: RESPONSE_SCHEMA,
        }),
      (e: unknown) => {
        assert.ok(
          e instanceof StructuredOutputValidationError,
          `expected StructuredOutputValidationError, got ${(e as Error).constructor.name}`,
        );
        assert.deepStrictEqual(e.schema, TEST_SCHEMA, "error should carry the schema");
        return true;
      },
    );
  });

  it("does NOT throw on conformant synthetic tool arguments", async () => {
    const conformantData = { name: "Alice", count: 5 };
    const fetchImpl = async () => syntheticToolOnlyResponse(conformantData);

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    assert.ok(out.content, "should return content without throwing");
    assert.equal(out.toolCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Mode "none": no synthetic tool injection
// ---------------------------------------------------------------------------

describe("Anthropic structured output — mode none", () => {
  it("does NOT inject synthetic tool when mode is none", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return anthropicJsonResponse([
        {
          type: "tool_use",
          id: "toolu_1",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
        },
      ]);
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "read a file" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "none",
    });

    const body = JSON.parse(capturedBody ?? "{}") as { tools?: { name: string }[] };
    assert.ok(body.tools, "tools should be present");
    const syntheticTool = body.tools.find((t) => t.name === "__structured_output__");
    assert.equal(
      syntheticTool,
      undefined,
      "synthetic tool should NOT be injected when mode is none",
    );
    assert.equal(body.tools.length, 1, "only the real tool should be present");
  });

  it("does not strip or reinterpret tool calls when mode is none", async () => {
    const fetchImpl = async () =>
      anthropicJsonResponse([
        {
          type: "tool_use",
          id: "toolu_1",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
        },
      ]);

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    const out = await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "read a file" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "none",
    });

    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "read_file");
  });
});

// ---------------------------------------------------------------------------
// 7. Mode "strict" is downgraded to "best-effort"
// ---------------------------------------------------------------------------

describe("Anthropic structured output — strict downgrade", () => {
  it("strict mode is downgraded to best-effort: still injects synthetic tool and validates", async () => {
    let capturedBody: string | undefined;
    const conformantData = { name: "Alice", count: 5 };
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return syntheticToolOnlyResponse(conformantData);
    };

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    // Explicitly set "strict" — should be downgraded to "best-effort" by resolveStructuredOutputMode
    await p.completeWithTools({
      model: "claude-3",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "strict",
    });

    // Synthetic tool should still be injected (downgraded to best-effort, not none)
    const body = JSON.parse(capturedBody ?? "{}") as { tools?: { name: string }[] };
    assert.ok(body.tools, "tools should be present");
    const syntheticTool = body.tools.find((t) => t.name === "__structured_output__");
    assert.ok(
      syntheticTool,
      "synthetic tool should be injected even when strict is configured (downgraded to best-effort)",
    );
  });

  it("strict mode downgraded to best-effort still throws on non-conformant response", async () => {
    // Missing required "count" field
    const nonConformantData = { name: "Alice" };
    const fetchImpl = async () => syntheticToolOnlyResponse(nonConformantData);

    const p = createAnthropicMessagesProvider({
      id: "anth",
      baseUrl: "https://api.anthropic.com",
      fetchImpl,
    });

    // "strict" is downgraded to "best-effort" → post-validation still runs
    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "claude-3",
          messages: [{ role: "user", content: "give me data" }],
          tools: TOOLS,
          responseSchema: RESPONSE_SCHEMA,
          structuredOutputMode: "strict",
        }),
      (e: unknown) => {
        assert.ok(
          e instanceof StructuredOutputValidationError,
          `expected StructuredOutputValidationError, got ${(e as Error).constructor.name}`,
        );
        return true;
      },
    );
  });
});
