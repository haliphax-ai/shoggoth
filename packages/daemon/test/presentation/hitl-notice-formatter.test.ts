import { describe, it, expect, beforeEach } from "vitest";
import { setNoticeResolver } from "../../src/presentation/notices";
import {
  formatHitlPayloadExcerpt,
  buildHitlQueuedNoticeLines,
  HITL_NOTICE_PAYLOAD_MAX_CHARS,
  type HitlPendingActionRow,
} from "../../src/presentation/hitl-notice-formatter";

beforeEach(() => {
  setNoticeResolver((key, vars = {}) => {
    const varStr = Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return varStr ? `[${key}:${varStr}]` : `[${key}]`;
  });
});

describe("formatHitlPayloadExcerpt", () => {
  it("returns undefined for null/undefined", () => {
    expect(formatHitlPayloadExcerpt(null)).toBeUndefined();
    expect(formatHitlPayloadExcerpt(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string payload", () => {
    expect(formatHitlPayloadExcerpt("")).toBeUndefined();
  });

  it("returns string payload as-is when short", () => {
    expect(formatHitlPayloadExcerpt("hello")).toBe("hello");
  });

  it("JSON-stringifies object payloads", () => {
    expect(formatHitlPayloadExcerpt({ a: 1 })).toBe('{"a":1}');
  });

  it("truncates long payloads with ellipsis", () => {
    const long = "x".repeat(HITL_NOTICE_PAYLOAD_MAX_CHARS + 100);
    const result = formatHitlPayloadExcerpt(long)!;
    expect(result.length).toBe(HITL_NOTICE_PAYLOAD_MAX_CHARS);
    expect(result).toEndWith("…");
  });

  it("respects custom maxChars", () => {
    const result = formatHitlPayloadExcerpt("abcdefghij", 5)!;
    expect(result.length).toBe(5);
    expect(result).toEndWith("…");
  });

  it("collapses newlines and replaces backticks", () => {
    expect(formatHitlPayloadExcerpt("line1\nline2")).toBe("line1 line2");
    expect(formatHitlPayloadExcerpt("`code`")).toBe("'code'");
  });
});

describe("buildHitlQueuedNoticeLines", () => {
  it("returns lines from the notice template", () => {
    const row: HitlPendingActionRow = {
      id: "p1",
      sessionId: "s1",
      correlationId: "corr1",
      toolName: "exec",
      payload: { cmd: "ls" },
      riskTier: "high",
    };
    const lines = buildHitlQueuedNoticeLines(row);
    expect(lines.length).toBeGreaterThan(0);
    // The notice resolver returns a single line with key + vars
    expect(lines.join("\n")).toContain("hitl-queued-notice");
  });

  it("omits correlation line when correlationId is undefined", () => {
    const row: HitlPendingActionRow = {
      id: "p2",
      sessionId: "s2",
      correlationId: undefined,
      toolName: "read",
      payload: null,
      riskTier: "low",
    };
    const lines = buildHitlQueuedNoticeLines(row);
    const joined = lines.join("\n");
    expect(joined).toContain("hitl-queued-notice");
    // correlationLine should be empty
    expect(joined).not.toContain("run:");
  });
});
