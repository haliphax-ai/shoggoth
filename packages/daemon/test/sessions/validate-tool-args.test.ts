import { describe, it, expect } from "vitest";
import { validateToolArgs } from "../../src/sessions/validate-tool-args";

describe("validateToolArgs", () => {
  it("returns empty for valid args matching schema", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path"],
    };
    const errors = validateToolArgs({ path: "/tmp/foo", limit: 10 }, schema);
    expect(errors).toEqual([]);
  });

  it("reports missing required fields", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const errors = validateToolArgs({}, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("path");
    expect(errors[0].message).toContain("required");
  });

  it("reports type mismatch", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
    };
    const errors = validateToolArgs({ count: "not-a-number" }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("count");
    expect(errors[0].message).toContain("number");
  });

  it("reports integer type when given a float", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer" } },
    };
    const errors = validateToolArgs({ n: 1.5 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("n");
  });

  it("accepts integer for integer type", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer" } },
    };
    expect(validateToolArgs({ n: 3 }, schema)).toEqual([]);
  });

  it("reports enum violation", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "post", "delete"] },
      },
    };
    const errors = validateToolArgs({ action: "patch" }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("action");
    expect(errors[0].message).toContain("patch");
  });

  it("reports minimum violation", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "number", minimum: 1 } },
    };
    const errors = validateToolArgs({ limit: 0 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("minimum");
  });

  it("reports maximum violation", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "number", maximum: 100 } },
    };
    const errors = validateToolArgs({ limit: 200 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("maximum");
  });

  it("skips absent optional fields", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        optional: { type: "number" },
      },
      required: ["path"],
    };
    expect(validateToolArgs({ path: "/foo" }, schema)).toEqual([]);
  });

  it("validates array type", () => {
    const schema = {
      type: "object",
      properties: { argv: { type: "array" } },
      required: ["argv"],
    };
    expect(validateToolArgs({ argv: ["ls"] }, schema)).toEqual([]);
    const errors = validateToolArgs({ argv: "ls" }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("array");
  });

  it("validates boolean type", () => {
    const schema = {
      type: "object",
      properties: { recursive: { type: "boolean" } },
    };
    expect(validateToolArgs({ recursive: true }, schema)).toEqual([]);
    const errors = validateToolArgs({ recursive: "yes" }, schema);
    expect(errors).toHaveLength(1);
  });

  it("returns multiple errors at once", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path", "limit"],
    };
    const errors = validateToolArgs({}, schema);
    expect(errors).toHaveLength(2);
  });

  it("accepts schema with no type field (implicit object)", () => {
    const schema = {
      properties: { x: { type: "string" } },
      required: ["x"],
    };
    expect(validateToolArgs({ x: "hi" }, schema)).toEqual([]);
  });

  it("rejects non-object top-level schema type", () => {
    const schema = { type: "string" };
    const errors = validateToolArgs({} as Record<string, unknown>, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("(root)");
  });

  it("rejects unknown arguments not in schema properties", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
    };
    const errors = validateToolArgs({ path: "/foo", mystery: 42 }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("mystery");
    expect(errors[0].message).toContain("unknown argument");
  });

  it("rejects multiple unknown arguments", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
    };
    const errors = validateToolArgs(
      { path: "/foo", extra1: "a", extra2: "b" },
      schema,
    );
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.field)).toContain("extra1");
    expect(errors.map((e) => e.field)).toContain("extra2");
  });

  it("allows extra arguments when additionalProperties is true", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: true,
    };
    const errors = validateToolArgs({ path: "/foo", mystery: 42 }, schema);
    expect(errors).toEqual([]);
  });

  it("rejects unknown arguments when additionalProperties is false", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    };
    const errors = validateToolArgs({ path: "/foo", extra: "bad" }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("extra");
  });

  it("reports both unknown and other validation errors together", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path"],
    };
    const errors = validateToolArgs(
      { limit: "not-a-number", mystery: true },
      schema,
    );
    expect(errors).toHaveLength(3);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("path");
    expect(fields).toContain("limit");
    expect(fields).toContain("mystery");
  });

  it("allows args with no properties defined in schema (open schema)", () => {
    const schema = { type: "object" };
    const errors = validateToolArgs({ anything: "goes" }, schema);
    expect(errors).toEqual([]);
  });
});
