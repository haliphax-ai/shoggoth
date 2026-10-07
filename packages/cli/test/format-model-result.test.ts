import { describe, it } from "vitest";
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

  it("omits the session line when session_id is missing", () => {
    const out = formatModelResult({
      model_selection: null,
      effective_models: null,
    });
    assert.ok(!out.includes("Session:"));
    assert.ok(!out.includes("undefined"));
  });

  it("omits the session line when session_id is not a string", () => {
    const out = formatModelResult({
      session_id: 42,
      model_selection: null,
      effective_models: null,
    });
    assert.ok(!out.includes("Session:"));
    assert.ok(!out.includes("42"));
  });

  it("ignores effective_models that is not an object", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: null,
      effective_models: "anthropic/claude-3-5-sonnet",
    });
    assert.ok(!out.includes("Effective:"));
  });

  it("ignores non-string providerId or model in effective_models", () => {
    const out = formatModelResult({
      session_id: "sess-1",
      model_selection: null,
      effective_models: { providerId: 7, model: { nested: true } },
    });
    assert.ok(!out.includes("Effective:"));
  });

  it("tolerates input that is not an object", () => {
    const out = formatModelResult(null);
    assert.ok(out.includes("Model Configuration"));
    assert.ok(!out.includes("undefined"));
  });

  it("shows default when model_selection is absent", () => {
    const out = formatModelResult({ session_id: "sess-1" });
    assert.ok(out.includes("(using default)"));
    assert.ok(!out.includes("Effective:"));
  });
});
