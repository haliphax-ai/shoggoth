import { describe, it, expect, beforeEach } from "vitest";
import {
  setNoticeResolver,
  formatHitlPayloadExcerpt,
  buildHitlQueuedNoticeLines,
  HITL_NOTICE_PAYLOAD_MAX_CHARS,
} from "../../src/presentation/index.js";

function stubResolver(key: string, vars: Record<string, string> = {}): string {
  return `${key}:${JSON.stringify(vars)}`;
}

beforeEach(() => {
  setNoticeResolver(stubResolver);
});

describe("formatHitlPayloadExcerpt", () => {
  it("returns undefined for null/undefined", () => {
    expect(formatHitlPayloadExcerpt(null)).toBeUndefined();
    expect(formatHitlPayloadExcerpt(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(formatHitlPayloadExcerpt("")).toBeUndefined();
  });

  it("returns string payload as-is when short", () => {
    expect(formatHitlPayloadExcerpt("hello")).toBe("hello");
  });

  it("JSON-stringifies objects", () => {
    expect(formatHitlPayloadExcerpt({ a: 1 })).toBe('{"a":1}');
  });

  it("truncates long payloads", () => {
    const long = "x".repeat(HITL_NOTICE_PAYLOAD_MAX_CHARS + 100);
    const result = formatHitlPayloadExcerpt(long)!;
    expect(result.length).toBe(HITL_NOTICE_PAYLOAD_MAX_CHARS);
    expect(result).toMatch(/…$/);
  });

  it("replaces backticks with single quotes", () => {
    expect(formatHitlPayloadExcerpt("foo`bar`baz")).toBe("foo'bar'baz");
  });

  it("collapses newlines to spaces", () => {
    expect(formatHitlPayloadExcerpt("line1\nline2\r\nline3")).toBe("line1 line2 line3");
  });

  it("respects custom maxChars", () => {
    const result = formatHitlPayloadExcerpt("abcdefghij", 5)!;
    expect(result.length).toBe(5);
    expect(result).toBe("abcd…");
  });
});

describe("buildHitlQueuedNoticeLines", () => {
  it("produces lines from daemonNotice", () => {
    const lines = buildHitlQueuedNoticeLines({
      id: "p1",
      sessionId: "s1",
      correlationId: undefined,
      toolName: "exec",
      payload: "rm -rf /",
      riskTier: "high" as any,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("hitl-queued-notice");
    expect(lines.join("\n")).toContain("p1");
    expect(lines.join("\n")).toContain("exec");
  });

  it("includes correlation line when present", () => {
    const lines = buildHitlQueuedNoticeLines({
      id: "p2",
      sessionId: "s2",
      correlationId: "corr-abc",
      toolName: "write",
      payload: null,
      riskTier: "medium" as any,
    });
    const joined = lines.join("\n");
    expect(joined).toContain("corr-abc");
  });
});
