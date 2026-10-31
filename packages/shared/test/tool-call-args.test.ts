import { describe, it, expect } from "vitest";
import { normalizeToolCallArgsJson } from "../src/tool-call-args";

describe("normalizeToolCallArgsJson", () => {
  it("returns valid JSON unchanged", () => {
    const args = '{"path":"/tmp/a.txt","content":"hello"}';
    expect(normalizeToolCallArgsJson(args)).toBe(args);
  });

  it("repairs invalid escape sequences", () => {
    const args = '{"pattern":"\\d+"}';
    expect(() => JSON.parse(normalizeToolCallArgsJson(args))).not.toThrow();
  });

  it("falls back to an empty object for truncated JSON", () => {
    const truncated = '{"path":"/tmp/a.txt","content":"line one\\nline two';
    expect(normalizeToolCallArgsJson(truncated)).toBe("{}");
  });

  it("falls back to an empty object for a non-string value", () => {
    expect(normalizeToolCallArgsJson(undefined)).toBe("{}");
    expect(normalizeToolCallArgsJson(null)).toBe("{}");
    expect(normalizeToolCallArgsJson(42)).toBe("{}");
  });

  it("always returns parseable JSON", () => {
    const inputs = ["", "{", '{"a":', '{"a":"unterminated', "not json at all", '{"a":1}'];
    for (const input of inputs) {
      expect(() => JSON.parse(normalizeToolCallArgsJson(input))).not.toThrow();
    }
  });
});
