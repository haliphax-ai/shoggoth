import { describe, it } from "node:test";
import assert from "node:assert";
import { formatModelResult } from "../src/format-model-result";

describe("formatModelResult", () => {
  it("formats string model_selection", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: "anthropic/claude-3-5-sonnet",
      effective_models: null,
    });
    assert.ok(out.includes("sess-1"));
    assert.ok(out.includes("anthropic/claude-3-5-sonnet"));
  });

  it("formats object model_selection as JSON", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: { providerId: "openai", model: "gpt-4" },
      effective_models: null,
    });
    assert.ok(out.includes("sess-1"));
    assert.ok(out.includes("openai"));
    assert.ok(out.includes("gpt-4"));
    assert.ok(!out.includes("[object Object]"));
  });

  it("shows default when model_selection is null", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: null,
      effective_models: null,
    });
    assert.ok(out.includes("(using default)"));
  });

  it("includes effective model when present", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: null,
      effective_models: { providerId: "anthropic", model: "claude-3-5-sonnet" },
    });
    assert.ok(out.includes("anthropic/claude-3-5-sonnet"));
  });
});
