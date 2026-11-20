/**
 * OOB response schema constants: OOB_SCHEMA_WITH_SENDER requires nullable
 * `to_operator` and `to_sender` strings, OOB_SCHEMA_NO_SENDER requires only
 * `to_operator` (both with additionalProperties: false), and the guidance
 * strings are non-empty and mention structured output.
 */
import { describe, it, expect } from "vitest";
import { validateResponseSchema } from "@shoggoth/models";

import {
  OOB_SCHEMA_WITH_SENDER,
  OOB_SCHEMA_NO_SENDER,
  OOB_WITH_SENDER_GUIDANCE,
  OOB_NO_SENDER_GUIDANCE,
} from "../../src/messaging/oob-response-schemas";

describe("OOB_SCHEMA_WITH_SENDER", () => {
  it("is a JSON Schema object with type 'object'", () => {
    expect(OOB_SCHEMA_WITH_SENDER).toMatchObject({ type: "object" });
  });

  it("requires both to_operator and to_sender", () => {
    const required = (OOB_SCHEMA_WITH_SENDER as { required?: string[] }).required ?? [];
    expect(required).toContain("to_operator");
    expect(required).toContain("to_sender");
  });

  it("declares to_operator and to_sender as nullable strings", () => {
    const properties =
      (
        OOB_SCHEMA_WITH_SENDER as {
          properties?: Record<string, { type?: string[] | string }>;
        }
      ).properties ?? {};
    expect(properties.to_operator?.type).toEqual(["string", "null"]);
    expect(properties.to_sender?.type).toEqual(["string", "null"]);
  });

  it("disallows additional properties", () => {
    expect(OOB_SCHEMA_WITH_SENDER).toMatchObject({ additionalProperties: false });
  });

  it("accepts a payload with both fields set", () => {
    const result = validateResponseSchema(
      JSON.stringify({ to_operator: "hello operator", to_sender: "hello sender" }),
      OOB_SCHEMA_WITH_SENDER as unknown as Record<string, unknown>,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a payload missing to_sender", () => {
    const result = validateResponseSchema(
      JSON.stringify({ to_operator: "hello operator" }),
      OOB_SCHEMA_WITH_SENDER as unknown as Record<string, unknown>,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a payload with an unknown property", () => {
    const result = validateResponseSchema(
      JSON.stringify({ to_operator: "op", to_sender: "sender", extra: "nope" }),
      OOB_SCHEMA_WITH_SENDER as unknown as Record<string, unknown>,
    );
    expect(result.valid).toBe(false);
  });
});

describe("OOB_SCHEMA_NO_SENDER", () => {
  it("is a JSON Schema object with type 'object'", () => {
    expect(OOB_SCHEMA_NO_SENDER).toMatchObject({ type: "object" });
  });

  it("requires to_operator", () => {
    const required = (OOB_SCHEMA_NO_SENDER as { required?: string[] }).required ?? [];
    expect(required).toContain("to_operator");
  });

  it("does not require to_sender", () => {
    const required = (OOB_SCHEMA_NO_SENDER as { required?: string[] }).required ?? [];
    expect(required).not.toContain("to_sender");
  });

  it("declares to_operator as a nullable string", () => {
    const properties =
      (
        OOB_SCHEMA_NO_SENDER as {
          properties?: Record<string, { type?: string[] | string }>;
        }
      ).properties ?? {};
    expect(properties.to_operator?.type).toEqual(["string", "null"]);
  });

  it("disallows additional properties", () => {
    expect(OOB_SCHEMA_NO_SENDER).toMatchObject({ additionalProperties: false });
  });

  it("accepts a payload with only to_operator", () => {
    const result = validateResponseSchema(
      JSON.stringify({ to_operator: "timer fired" }),
      OOB_SCHEMA_NO_SENDER as unknown as Record<string, unknown>,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a payload missing to_operator", () => {
    const result = validateResponseSchema(
      JSON.stringify({}),
      OOB_SCHEMA_NO_SENDER as unknown as Record<string, unknown>,
    );
    expect(result.valid).toBe(false);
  });
});

describe("OOB guidance strings", () => {
  it("OOB_WITH_SENDER_GUIDANCE mentions structured output", () => {
    expect(OOB_WITH_SENDER_GUIDANCE).toContain("structured output");
  });

  it("OOB_NO_SENDER_GUIDANCE mentions structured output", () => {
    expect(OOB_NO_SENDER_GUIDANCE).toContain("structured output");
  });
});
