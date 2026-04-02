import { describe, it, expect, beforeEach } from "vitest";
import {
  setNoticeResolver,
  formatDegradedPrefix,
  formatModelTagFooter,
  formatErrorUserText,
} from "../../src/presentation/index.js";
import { ModelHttpError } from "@shoggoth/models";

function stubResolver(key: string, vars: Record<string, string> = {}): string {
  return `${key}:${JSON.stringify(vars)}`;
}

beforeEach(() => {
  setNoticeResolver(stubResolver);
});

describe("formatDegradedPrefix", () => {
  it("returns empty string when meta is undefined", () => {
    expect(formatDegradedPrefix(undefined)).toBe("");
  });

  it("returns empty string when not degraded", () => {
    expect(formatDegradedPrefix({ degraded: false, usedModel: "m", usedProviderId: "p" })).toBe("");
  });

  it("returns degraded banner when degraded", () => {
    const result = formatDegradedPrefix({ degraded: true, usedModel: "gpt-4", usedProviderId: "openai" });
    expect(result).toContain("degraded-banner");
    expect(result).toContain("gpt-4");
    expect(result).toContain("openai");
    expect(result).toMatch(/\n\n$/);
  });
});

describe("formatModelTagFooter", () => {
  it("returns empty when env flag is not set", () => {
    expect(formatModelTagFooter({}, { degraded: false, usedModel: "m", usedProviderId: "p" })).toBe("");
  });

  it("returns empty when meta is undefined", () => {
    expect(formatModelTagFooter({ SHOGGOTH_MODEL_TAG: "1" }, undefined)).toBe("");
  });

  it("returns footer with SHOGGOTH_MODEL_TAG=1", () => {
    const result = formatModelTagFooter(
      { SHOGGOTH_MODEL_TAG: "1" } as NodeJS.ProcessEnv,
      { degraded: false, usedModel: "claude", usedProviderId: "anthropic" },
    );
    expect(result).toContain("model-tag-footer");
    expect(result).toContain("claude");
    expect(result).toMatch(/^\n\n/);
  });

  it("returns footer with legacy SHOGGOTH_DISCORD_MODEL_TAG=1", () => {
    const result = formatModelTagFooter(
      { SHOGGOTH_DISCORD_MODEL_TAG: "1" } as NodeJS.ProcessEnv,
      { degraded: false, usedModel: "m", usedProviderId: "p" },
    );
    expect(result).toContain("model-tag-footer");
  });
});

describe("formatErrorUserText", () => {
  it("truncates long error messages", () => {
    const long = "x".repeat(500);
    const result = formatErrorUserText(new Error(long));
    expect(result.length).toBeLessThanOrEqual(360);
    expect(result).toMatch(/…$/);
  });

  it("handles ModelHttpError 429", () => {
    const err = new ModelHttpError(429, "rate limited");
    expect(formatErrorUserText(err)).toContain("error-model-429");
  });

  it("handles ModelHttpError 500", () => {
    const err = new ModelHttpError(500, "internal");
    expect(formatErrorUserText(err)).toContain("error-model-500");
  });

  it("handles ModelHttpError 502/503/504", () => {
    for (const status of [502, 503, 504]) {
      const err = new ModelHttpError(status, "bad gateway");
      expect(formatErrorUserText(err)).toContain("error-model-502-504");
    }
  });

  it("handles fetch-like TypeError", () => {
    const err = new TypeError("fetch failed: ECONNREFUSED");
    expect(formatErrorUserText(err)).toContain("error-network-fetch");
  });

  it("handles hitl_pending error", () => {
    const err = new Error("hitl_pending:abc-123 waiting");
    expect(formatErrorUserText(err)).toContain("error-hitl-pending");
    expect(formatErrorUserText(err)).toContain("abc-123");
  });

  it("handles plain string", () => {
    expect(formatErrorUserText("something broke")).toBe("something broke");
  });
});
