import { describe, it } from "vitest";
import assert from "node:assert";
import {
  mergeModelInvocationParams,
  mergeSubagentSpawnModelSelection,
  parseModelInvocationFromUnknown,
} from "../src/invocation-merge";
import type { ShoggothModelsConfig } from "@shoggoth/shared";

describe("model invocation merge", () => {
  it("parses session model_selection fields", () => {
    const p = parseModelInvocationFromUnknown({
      maxOutputTokens: 9000,
      temperature: 0.1,
      thinking: { enabled: true, budgetTokens: 5000 },
      reasoningEffort: "high",
      requestExtras: { foo: 1 },
    });
    assert.equal(p.maxOutputTokens, 9000);
    assert.equal(p.temperature, 0.1);
    assert.equal(p.thinking?.enabled, true);
    assert.equal(p.thinking?.budgetTokens, 5000);
    assert.equal(p.reasoningEffort, "high");
    assert.deepEqual(p.requestExtras, { foo: 1 });
  });

  it("accepts extraBody alias for requestExtras", () => {
    const p = parseModelInvocationFromUnknown({ extraBody: { x: true } });
    assert.deepEqual(p.requestExtras, { x: true });
  });

  it("merges defaultInvocation with session; session overrides per field", () => {
    const models: ShoggothModelsConfig = {
      defaultInvocation: {
        maxOutputTokens: 1000,
        temperature: 0.5,
        thinking: { enabled: false },
        requestExtras: { a: 1 },
      },
    };
    const m = mergeModelInvocationParams(models, {
      temperature: 0.2,
      requestExtras: { b: 2 },
    });
    assert.equal(m.maxOutputTokens, 1000);
    assert.equal(m.temperature, 0.2);
    assert.equal(m.thinking?.enabled, false);
    assert.deepEqual(m.requestExtras, { a: 1, b: 2 });
  });

  it("mergeSubagentSpawnModelSelection inherits parent and overlays invocation + other keys", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parent-model", temperature: 0.3, requestExtras: { a: 1 } },
      { temperature: 0.9, requestExtras: { b: 2 } },
    ) as Record<string, unknown>;
    assert.equal(merged.model, "parent-model");
    assert.equal(merged.temperature, 0.9);
    assert.deepEqual(merged.requestExtras, { a: 1, b: 2 });
  });

  it("mergeSubagentSpawnModelSelection with no parent returns overlay only", () => {
    const merged = mergeSubagentSpawnModelSelection(undefined, { reasoningEffort: "low" }) as Record<
      string,
      unknown
    >;
    assert.deepEqual(merged, { reasoningEffort: "low" });
  });

  it("mergeSubagentSpawnModelSelection parent only copies selection", () => {
    const merged = mergeSubagentSpawnModelSelection({ maxOutputTokens: 2048 }, undefined) as Record<
      string,
      unknown
    >;
    assert.deepEqual(merged, { maxOutputTokens: 2048 });
  });
});
