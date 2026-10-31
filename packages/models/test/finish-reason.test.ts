import { describe, it, expect } from "vitest";
import { isTruncationFinishReason } from "../src/finish-reason";

describe("isTruncationFinishReason", () => {
  it("recognizes the OpenAI-compatible stop reason", () => {
    expect(isTruncationFinishReason("length")).toBe(true);
  });

  it("recognizes the Anthropic stop reason", () => {
    expect(isTruncationFinishReason("max_tokens")).toBe(true);
  });

  it("recognizes the Gemini stop reason", () => {
    expect(isTruncationFinishReason("MAX_TOKENS")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isTruncationFinishReason("  Length ")).toBe(true);
    expect(isTruncationFinishReason("MAX_OUTPUT_TOKENS")).toBe(true);
  });

  it("does not treat normal stop reasons as truncation", () => {
    expect(isTruncationFinishReason("stop")).toBe(false);
    expect(isTruncationFinishReason("tool_calls")).toBe(false);
    expect(isTruncationFinishReason("tool_use")).toBe(false);
    expect(isTruncationFinishReason("STOP")).toBe(false);
    expect(isTruncationFinishReason("content_filter")).toBe(false);
  });

  it("treats an absent reason as not truncated", () => {
    expect(isTruncationFinishReason(undefined)).toBe(false);
    expect(isTruncationFinishReason("")).toBe(false);
  });
});
