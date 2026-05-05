import { describe, it } from "vitest";
import assert from "node:assert";
import {
  validateResponseSchema,
  resolveStructuredOutputMode,
  StructuredOutputValidationError,
} from "../src/response-validation";

// ---------------------------------------------------------------------------
// validateResponseSchema
// ---------------------------------------------------------------------------
describe("validateResponseSchema", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
    additionalProperties: false,
  };

  it("valid JSON conforming to schema returns { valid: true, data: <parsed> }", () => {
    const content = JSON.stringify({ name: "Alice", age: 30 });
    const result = validateResponseSchema(content, schema);
    assert.equal(result.valid, true);
    assert.ok(result.valid === true && "data" in result);
    assert.deepEqual((result as { valid: true; data: unknown }).data, { name: "Alice", age: 30 });
  });

  it("valid JSON not conforming to schema returns { valid: false, error, rawContent }", () => {
    const content = JSON.stringify({ name: "Alice" }); // missing required "age"
    const result = validateResponseSchema(content, schema);
    assert.equal(result.valid, false);
    assert.ok(result.valid === false && "error" in result);
    const failure = result as { valid: false; error: string; rawContent: string };
    assert.equal(typeof failure.error, "string");
    assert.ok(failure.error.length > 0, "error should be non-empty");
    assert.equal(failure.rawContent, content);
  });

  it("non-JSON content returns { valid: false, error: <parse error>, rawContent }", () => {
    const content = "this is not json at all";
    const result = validateResponseSchema(content, schema);
    assert.equal(result.valid, false);
    const failure = result as { valid: false; error: string; rawContent: string };
    assert.ok(failure.error.toLowerCase().includes("json"), "error should mention JSON");
    assert.equal(failure.rawContent, content);
  });

  it("error messages include schema path info for nested validation failures", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            email: { type: "string" },
            settings: {
              type: "object",
              properties: {
                theme: { type: "string" },
              },
              required: ["theme"],
            },
          },
          required: ["email", "settings"],
        },
      },
      required: ["user"],
    };
    // Missing required "theme" inside user.settings
    const content = JSON.stringify({ user: { email: "a@b.com", settings: {} } });
    const result = validateResponseSchema(content, nestedSchema);
    assert.equal(result.valid, false);
    const failure = result as { valid: false; error: string; rawContent: string };
    // Error should contain path info pointing to the nested location
    assert.ok(
      failure.error.includes("settings") || failure.error.includes("/user/settings"),
      `error should include schema path info, got: ${failure.error}`,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveStructuredOutputMode
// ---------------------------------------------------------------------------
describe("resolveStructuredOutputMode", () => {
  it("configured=undefined, ceiling='strict' returns 'strict'", () => {
    const result = resolveStructuredOutputMode(undefined, "strict");
    assert.equal(result, "strict");
  });

  it("configured=undefined, ceiling='best-effort' returns 'best-effort'", () => {
    const result = resolveStructuredOutputMode(undefined, "best-effort");
    assert.equal(result, "best-effort");
  });

  it("configured='strict', ceiling='best-effort' returns 'best-effort' (downgraded)", () => {
    const result = resolveStructuredOutputMode("strict", "best-effort");
    assert.equal(result, "best-effort");
  });

  it("configured='best-effort', ceiling='strict' returns 'best-effort'", () => {
    const result = resolveStructuredOutputMode("best-effort", "strict");
    assert.equal(result, "best-effort");
  });

  it("configured='none', ceiling='strict' returns 'none'", () => {
    const result = resolveStructuredOutputMode("none", "strict");
    assert.equal(result, "none");
  });

  it("configured='none', ceiling='best-effort' returns 'none'", () => {
    const result = resolveStructuredOutputMode("none", "best-effort");
    assert.equal(result, "none");
  });

  it("configured='strict', ceiling='strict' returns 'strict'", () => {
    const result = resolveStructuredOutputMode("strict", "strict");
    assert.equal(result, "strict");
  });
});

// ---------------------------------------------------------------------------
// StructuredOutputValidationError
// ---------------------------------------------------------------------------
describe("StructuredOutputValidationError", () => {
  it("is an instance of Error", () => {
    const err = new StructuredOutputValidationError("validation failed", '{"bad": true}', {
      type: "object",
      properties: { good: { type: "string" } },
      required: ["good"],
    });
    assert.ok(err instanceof Error);
  });

  it('has name "StructuredOutputValidationError"', () => {
    const err = new StructuredOutputValidationError("validation failed", '{"bad": true}', {
      type: "object",
    });
    assert.equal(err.name, "StructuredOutputValidationError");
  });

  it("carries rawContent and schema properties", () => {
    const rawContent = '{"incomplete": true}';
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const err = new StructuredOutputValidationError("test error", rawContent, schema);
    assert.equal(err.rawContent, rawContent);
    assert.deepEqual(err.schema, schema);
    assert.equal(err.message, "test error");
  });
});
