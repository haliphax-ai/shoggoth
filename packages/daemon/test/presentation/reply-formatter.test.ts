import { describe, it, expect, beforeEach } from "vitest";
import { setNoticeResolver } from "../../src/presentation/notices";
import {
  formatDegradedPrefix,
  formatModelTagFooter,
  formatErrorUserText,
  formatAssistantReply,
  type FailoverMeta,
} from "../../src/presentation/reply-formatter";
import { ModelHttpError } from "@shoggoth/models";

// Install a minimal notice resolver so daemonNotice calls don't throw.
beforeEach(() => {
  setNoticeResolver((key, vars = {}) => {
    // Return a predictable string that encodes the key + vars for assertions.
    const varStr = Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return varStr ? `[${key}:${varStr}]` : `[${key}]`;
  });
});

describe("formatDegradedPrefix", () => {
  it("returns empty string when meta is undefined", () => {
    expect(formatDegradedPrefix(undefined)).toBe("");
  });

  it("returns empty string when not degraded", () => {
    const meta: FailoverMeta = { degraded: false, usedModel: "m", usedProviderId: "p" };
    expect(formatDegradedPrefix(meta)).toBe("");
  });

  it("returns degraded banner when degraded", () => {
    const meta: FailoverMeta = { degraded: true, usedModel: "gpt-4", usedProviderId: "openai" };
    const result = formatDegradedPrefix(meta);
    expect(result).toContain("degraded-banner");
    expect(result).toContain("gpt-4");
    expect(result).toContain("openai");
    expect(result.endsWith("\n\n")).toBe(true);
  });
});

describe("formatModelTagFooter", () => {
  it("returns empty string when env flags are off", () => {
    const meta: FailoverMeta = { degraded: false, usedModel: "m", usedProviderId: "p" };
    expect(formatModelTagFooter({}, meta)).toBe("");
  });

  it("returns empty string when meta is undefined", () => {
    expect(formatModelTagFooter({ SHOGGOTH_MODEL_TAG: "1" }, undefined)).toBe("");
  });

  it("returns footer when SHOGGOTH_MODEL_TAG=1", () => {
    const meta: FailoverMeta = { degraded: false, usedModel: "claude", usedProviderId: "anthropic" };
    const result = formatModelTagFooter({ SHOGGOTH_MODEL_TAG: "1" }, meta);
    expect(result).toContain("model-tag-footer");
    expect(result).toContain("claude");
    expect(result.startsWith("\n\n")).toBe(true);
  });

  it("returns footer when SHOGGOTH_DISCORD_MODEL_TAG=1 (legacy)", () => {
    const meta: FailoverMeta = { degraded: false, usedModel: "m", usedProviderId: "p" };
    const result = formatModelTagFooter({ SHOGGOTH_DISCORD_MODEL_TAG: "1" }, meta);
    expect(result).toContain("model-tag-footer");
  });
});

describe("formatErrorUserText", () => {
  it("formats ModelHttpError 429", () => {
    const err = new ModelHttpError(429, "rate limited");
    const result = formatErrorUserText(err);
    expect(result).toContain("error-model-429");
  });

  it("formats ModelHttpError 502/503/504", () => {
    for (const status of [502, 503, 504]) {
      const err = new ModelHttpError(status, "bad gateway");
      expect(formatErrorUserText(err)).toContain("error-model-502-504");
    }
  });

  it("formats ModelHttpError 500", () => {
    const err = new ModelHttpError(500, "internal");
    expect(formatErrorUserText(err)).toContain("error-model-500");
  });

  it("formats ModelHttpError 401", () => {
    const err = new ModelHttpError(401, "unauthorized");
    expect(formatErrorUserText(err)).toContain("error-model-401");
  });

  it("formats ModelHttpError 400 with body snippet", () => {
    const err = new ModelHttpError(400, "bad request", "some detail");
    const result = formatErrorUserText(err);
    expect(result).toContain("error-model-400-with-detail");
    expect(result).toContain("some detail");
  });

  it("formats ModelHttpError 400 without body snippet", () => {
    const err = new ModelHttpError(400, "bad request");
    expect(formatErrorUserText(err)).toContain("error-model-400-generic");
  });

  it("formats ModelHttpError with unknown status", () => {
    const err = new ModelHttpError(418, "teapot");
    const result = formatErrorUserText(err);
    expect(result).toContain("error-model-default");
    expect(result).toContain("418");
  });

  it("formats fetch-like TypeError", () => {
    const err = new TypeError("Failed to fetch");
    expect(formatErrorUserText(err)).toContain("error-network-fetch");
  });

  it("formats HITL pending error", () => {
    const err = new Error("blocked by hitl_pending:abc123 awaiting approval");
    const result = formatErrorUserText(err);
    expect(result).toContain("error-hitl-pending");
    expect(result).toContain("abc123");
  });

  it("truncates long generic error messages", () => {
    const err = new Error("x".repeat(500));
    const result = formatErrorUserText(err);
    expect(result.length).toBeLessThanOrEqual(360);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles non-Error values", () => {
    expect(formatErrorUserText("string error")).toBe("string error");
    expect(formatErrorUserText(42)).toBe("42");
  });
});

describe("formatAssistantReply", () => {
  it("composes degraded prefix + identity + text + footer", () => {
    const config = {
      agents: { list: { main: { emoji: "🤖" } } },
    } as any;
    const meta: FailoverMeta = { degraded: true, usedModel: "m", usedProviderId: "p" };
    const result = formatAssistantReply(config, "urn:shoggoth:agent:main", { SHOGGOTH_MODEL_TAG: "1" }, "hello", meta);
    // Should contain degraded prefix, the text, and footer
    expect(result).toContain("degraded-banner");
    expect(result).toContain("hello");
    expect(result).toContain("model-tag-footer");
  });

  it("returns just text when no degradation and no model tag", () => {
    const config = { agents: {} } as any;
    const result = formatAssistantReply(config, "sess1", {}, "hello", undefined);
    expect(result).toContain("hello");
    expect(result).not.toContain("degraded-banner");
    expect(result).not.toContain("model-tag-footer");
  });
});
