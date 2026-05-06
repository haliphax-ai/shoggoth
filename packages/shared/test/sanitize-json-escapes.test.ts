import { describe, it, expect } from "vitest";
import { sanitizeJsonEscapes } from "../src/sanitize-json-escapes";

describe("sanitizeJsonEscapes", () => {
  describe("valid escapes left alone", () => {
    it('preserves \\"', () => {
      const input = String.raw`{"pattern": "say \"hello\""}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\\\", () => {
      const input = String.raw`{"path": "C:\\Users\\test"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\/", () => {
      const input = String.raw`{"url": "http:\/\/example.com"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\b", () => {
      const input = String.raw`{"text": "back\bspace"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\f", () => {
      const input = String.raw`{"text": "form\ffeed"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\n", () => {
      const input = String.raw`{"text": "new\nline"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\r", () => {
      const input = String.raw`{"text": "carriage\rreturn"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\t", () => {
      const input = String.raw`{"text": "a\ttab"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\uXXXX", () => {
      const input = String.raw`{"emoji": "\u2603 snowman"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("preserves \\u with uppercase hex", () => {
      const input = String.raw`{"char": "\u00FF"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });
  });

  describe("invalid escapes fixed", () => {
    it("fixes \\{", () => {
      // LLM produces: {"pattern": "\d\{3\}"}  (invalid \d, \{, \} escapes)
      const input = String.raw`{"pattern": "\d\{3\}"}`;
      const result = sanitizeJsonEscapes(input);
      const expected = String.raw`{"pattern": "\\d\\{3\\}"}`;
      expect(result).toBe(expected);
    });

    it("fixes \\(", () => {
      const input = String.raw`{"pattern": "\(group\)"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "\\(group\\)"}`);
    });

    it("fixes \\[", () => {
      const input = String.raw`{"pattern": "\[bracket\]"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "\\[bracket\\]"}`);
    });

    it("fixes \\.", () => {
      const input = String.raw`{"pattern": "file\\.txt"}`;
      // Input chars: { " p a t t e r n " :   " f i l e \ . t x t " }
      // The \. is invalid → becomes \\.
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "file\\.txt"}`);
    });

    it("fixes \\-", () => {
      const input = String.raw`{"pattern": "[a\\-z]"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "[a\\-z]"}`);
    });

    it("fixes \\w", () => {
      const input = String.raw`{"pattern": "\\w+"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "\\w+"}`);
    });

    it("fixes \\d", () => {
      const input = String.raw`{"pattern": "\\d+"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "\\d+"}`);
    });

    it("fixes \\s", () => {
      const input = String.raw`{"pattern": "hello\\sworld"}`;
      const result = sanitizeJsonEscapes(input);
      expect(result).toBe(String.raw`{"pattern": "hello\\sworld"}`);
    });
  });

  describe("mixed content", () => {
    it("handles mix of valid and invalid escapes", () => {
      // Input: {"text": "line\nnew", "pattern": "\d+\.\d+"}
      // \n is valid, \d and \. are invalid
      const input = String.raw`{"text": "line\nnew", "pattern": "\d+\.\d+"}`;
      const expected = String.raw`{"text": "line\nnew", "pattern": "\\d+\\.\\d+"}`;
      expect(sanitizeJsonEscapes(input)).toBe(expected);
    });

    it("handles valid unicode mixed with invalid escapes", () => {
      const input = String.raw`{"emoji": "\u2603", "regex": "\w+"}`;
      const expected = String.raw`{"emoji": "\u2603", "regex": "\\w+"}`;
      expect(sanitizeJsonEscapes(input)).toBe(expected);
    });
  });

  describe("already-correct double escapes", () => {
    it("\\\\{ remains \\\\{", () => {
      // Input string contains: \\{ which is a valid \\ followed by {
      const input = String.raw`{"pattern": "\\{literal\\}"}`;
      // \\ is valid (produces literal backslash), then { is just a char
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("\\\\d remains \\\\d", () => {
      const input = String.raw`{"pattern": "\\d+"}`;
      // \\ is valid, then d is just a char
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("\\\\. remains \\\\.", () => {
      const input = String.raw`{"pattern": "\\."}`;
      // \\ is valid, then . is just a char
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("\\u followed by non-hex is escaped (e.g. \\users)", () => {
      const input = String.raw`{"path": "\users\local"}`;
      // \u is followed by "sers" — 's' is not hex, so \u is invalid
      // \l is also invalid
      const expected = String.raw`{"path": "\\users\\local"}`;
      expect(sanitizeJsonEscapes(input)).toBe(expected);
    });

    it("\\u followed by only 3 hex digits is escaped", () => {
      const input = String.raw`{"val": "\u00F"}`;
      // Only 3 hex digits after \u — invalid
      const expected = String.raw`{"val": "\\u00F"}`;
      expect(sanitizeJsonEscapes(input)).toBe(expected);
    });

    it("\\u followed by 4 hex digits is valid", () => {
      const input = String.raw`{"val": "\u00FF"}`;
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("no backslashes returns input unchanged", () => {
      const input = '{"key": "value", "num": 42}';
      expect(sanitizeJsonEscapes(input)).toBe(input);
    });

    it("empty string returns empty string", () => {
      expect(sanitizeJsonEscapes("")).toBe("");
    });

    it("backslash at end of string is escaped", () => {
      const input = '{"val": "trailing\\';
      const expected = '{"val": "trailing\\\\';
      expect(sanitizeJsonEscapes(input)).toBe(expected);
    });

    it("realistic regex pattern from LLM", () => {
      // LLM produces: {"pattern": "^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$"}
      const input = String.raw`{"pattern": "^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$"}`;
      const result = sanitizeJsonEscapes(input);
      // After fix, all \d and \. become \\d and \\.
      const expected = String.raw`{"pattern": "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$"}`;
      expect(result).toBe(expected);
      // The result should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(parsed.pattern).toBe(String.raw`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`);
    });

    it("result is parseable JSON when input has invalid escapes", () => {
      const input = String.raw`{"regex": "\w+\.\w+", "name": "test"}`;
      const result = sanitizeJsonEscapes(input);
      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(parsed.regex).toBe(String.raw`\w+\.\w+`);
      expect(parsed.name).toBe("test");
    });
  });
});
