import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import { createGeminiProvider } from "../src/gemini";
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

function geminiTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }],
  };
}

/** Build a Gemini response with a synthetic __structured_output__ tool call. */
function geminiSyntheticCallResponse(argsJson: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: "__structured_output__", args: JSON.parse(argsJson) } }],
          role: "model",
        },
        finishReason: "STOP",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Structured output: responseSchema present (default mode = best-effort)
// ---------------------------------------------------------------------------

describe("Gemini structured output — responseSchema present", () => {
  it("injects synthetic tool and toolConfig when responseSchema is set (no responseMimeType)", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiSyntheticCallResponse(conformantJson)), {
        status: 200,
      });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const genConfig = body.generationConfig as Record<string, unknown>;
    assert.ok(genConfig, "generationConfig should be present");
    // responseMimeType should NOT be set (prevents tool calling)
    assert.equal(genConfig.responseMimeType, undefined, "responseMimeType should not be set");
    // toolConfig should be set for auto function calling
    const toolConfig = genConfig.functionCallingConfig as { mode: string } | undefined;
    assert.ok(toolConfig, "functionCallingConfig should be present");
    assert.equal(toolConfig.mode, "AUTO");
    // Synthetic tool should be in the tools array
    const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    assert.ok(tools, "tools should be present");
    const fnDecls = tools[0]?.functionDeclarations ?? [];
    const synthetic = fnDecls.find((d) => d.name === "__structured_output__");
    assert.ok(synthetic, "synthetic __structured_output__ tool should be in tools");
  });

  it("sanitizes the synthetic tool schema for Gemini (removes additionalProperties)", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiSyntheticCallResponse(conformantJson)), {
        status: 200,
      });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const tools = body.tools as Array<{
      functionDeclarations: Array<{ name: string; parameters?: Record<string, unknown> }>;
    }>;
    const fnDecls = tools[0]?.functionDeclarations ?? [];
    const synthetic = fnDecls.find((d) => d.name === "__structured_output__");
    assert.ok(synthetic, "synthetic tool should be present");
    const schema = synthetic?.parameters;
    assert.ok(schema, "synthetic tool parameters should be present");
    assert.equal(
      "additionalProperties" in schema,
      false,
      "additionalProperties should be stripped by sanitizeSchemaForGemini",
    );
  });

  it("also sets responseMimeType and responseSchema in complete() (non-tool path)", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Bob", count: 10 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse(conformantJson)), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await p.complete({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      responseSchema: RESPONSE_SCHEMA,
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const genConfig = body.generationConfig as Record<string, unknown>;
    assert.ok(genConfig, "generationConfig should be present");
    assert.equal(genConfig.responseMimeType, "application/json");
    assert.ok(genConfig.responseSchema, "responseSchema should be present in generationConfig");
  });
});

// ---------------------------------------------------------------------------
// Structured output: post-validation
// ---------------------------------------------------------------------------

describe("Gemini structured output — post-validation", () => {
  it("runs post-validation and does NOT throw on conformant response", async () => {
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiTextResponse(conformantJson)), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });

    const out = await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
    });
    assert.ok(out.content);
  });

  it("throws StructuredOutputValidationError on non-conformant response", async () => {
    // Missing required "count" field
    const nonConformantJson = JSON.stringify({ name: "Alice" });
    let callCount = 0;
    const fetchImpl = async (_url: string | URL, _init?: RequestInit) => {
      callCount++;
      // First call: model returns text only (no tool calls) → triggers follow-up
      if (callCount === 1) {
        return new Response(JSON.stringify(geminiTextResponse("thinking...")), { status: 200 });
      }
      // Follow-up: model calls __structured_output__ with non-conformant JSON
      return new Response(JSON.stringify(geminiSyntheticCallResponse(nonConformantJson)), {
        status: 200,
      });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "gemini-pro",
          messages: [{ role: "user", content: "give me data" }],
          tools: TOOLS,
          responseSchema: RESPONSE_SCHEMA,
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

  it("throws StructuredOutputValidationError on non-conformant response in complete()", async () => {
    const nonConformantJson = JSON.stringify({ name: "Alice" });
    const fetchImpl = async () =>
      new Response(JSON.stringify(geminiTextResponse(nonConformantJson)), { status: 200 });

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await assert.rejects(
      () =>
        p.complete({
          model: "gemini-pro",
          messages: [{ role: "user", content: "give me data" }],
          responseSchema: RESPONSE_SCHEMA,
        }),
      (e: unknown) => e instanceof StructuredOutputValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Structured output: mode "none"
// ---------------------------------------------------------------------------

describe("Gemini structured output — mode none", () => {
  it("does NOT include synthetic tool or toolConfig when mode is none", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse("just text")), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "none",
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const genConfig = body.generationConfig as Record<string, unknown> | undefined;
    if (genConfig) {
      assert.equal(
        genConfig.functionCallingConfig,
        undefined,
        "functionCallingConfig should NOT be present when mode is none",
      );
    }
    // No synthetic tool should be in the tools array
    const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    if (tools) {
      const fnDecls = tools[0]?.functionDeclarations ?? [];
      const synthetic = fnDecls.find((d) => d.name === "__structured_output__");
      assert.equal(synthetic, undefined, "synthetic tool should NOT be present when mode is none");
    }
  });
});

// ---------------------------------------------------------------------------
// Structured output: responseSchema absent
// ---------------------------------------------------------------------------

describe("Gemini structured output — no responseSchema", () => {
  it("does NOT include responseMimeType or responseSchema when responseSchema is absent", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiTextResponse("just text")), { status: 200 });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      // No responseSchema
    });

    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const genConfig = body.generationConfig as Record<string, unknown> | undefined;
    if (genConfig) {
      assert.equal(genConfig.responseMimeType, undefined);
      assert.equal(genConfig.responseSchema, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Structured output: strict mode downgraded to best-effort
// ---------------------------------------------------------------------------

describe("Gemini structured output — strict downgrade", () => {
  it("strict mode is downgraded to best-effort (still injects synthetic tool and validates)", async () => {
    let capturedBody: string | undefined;
    const conformantJson = JSON.stringify({ name: "Alice", count: 5 });
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(geminiSyntheticCallResponse(conformantJson)), {
        status: 200,
      });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    // Explicitly set "strict" — should be downgraded to "best-effort" by resolveStructuredOutputMode
    await p.completeWithTools({
      model: "gemini-pro",
      messages: [{ role: "user", content: "give me data" }],
      tools: TOOLS,
      responseSchema: RESPONSE_SCHEMA,
      structuredOutputMode: "strict",
    });

    // Synthetic tool should be injected (downgraded to best-effort, not none)
    const body = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const fnDecls = tools[0]?.functionDeclarations ?? [];
    const synthetic = fnDecls.find((d) => d.name === "__structured_output__");
    assert.ok(synthetic, "synthetic tool should be present");
  });

  it("strict mode downgraded to best-effort still throws on non-conformant response", async () => {
    const nonConformantJson = JSON.stringify({ name: "Alice" });
    let callCount = 0;
    const fetchImpl = async (_url: string | URL, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(geminiTextResponse("thinking...")), { status: 200 });
      }
      return new Response(JSON.stringify(geminiSyntheticCallResponse(nonConformantJson)), {
        status: 200,
      });
    };

    const p = createGeminiProvider({ id: "g", fetchImpl });

    // "strict" is downgraded to "best-effort" → post-validation still runs
    await assert.rejects(
      () =>
        p.completeWithTools({
          model: "gemini-pro",
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
