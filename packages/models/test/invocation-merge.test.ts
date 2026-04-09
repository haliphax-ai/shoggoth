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

describe("mergeSubagentSpawnModelSelection with modelRef (Phase 2)", () => {
  it("modelRef overrides parent model", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parentProvider/parentModel", temperature: 0.5 },
      undefined,
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.equal(merged.model, "newProvider/newModel");
  });

  it("modelRef overrides overlay model", () => {
    const merged = mergeSubagentSpawnModelSelection(
      {},
      { model: "overlayProvider/overlayModel" },
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.equal(merged.model, "newProvider/newModel");
  });

  it("modelRef overrides both parent and overlay model", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parentProvider/parentModel" },
      { model: "overlayProvider/overlayModel" },
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.equal(merged.model, "newProvider/newModel");
  });

  it("modelRef with invocation params from parent and overlay still merges correctly", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parentProvider/parentModel", temperature: 0.3, requestExtras: { a: 1 } },
      { maxOutputTokens: 4096, requestExtras: { b: 2 } },
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.equal(merged.model, "newProvider/newModel");
    assert.equal(merged.temperature, 0.3);
    assert.equal(merged.maxOutputTokens, 4096);
    assert.deepEqual(merged.requestExtras, { a: 1, b: 2 });
  });

  it("undefined modelRef preserves existing behavior — parent model flows through", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parentProvider/parentModel", temperature: 0.5 },
      { temperature: 0.9 },
      undefined,
    ) as Record<string, unknown>;
    assert.equal(merged.model, "parentProvider/parentModel");
    assert.equal(merged.temperature, 0.9);
  });

  it("omitted modelRef preserves existing behavior — overlay model wins", () => {
    const merged = mergeSubagentSpawnModelSelection(
      { model: "parentProvider/parentModel" },
      { model: "overlayProvider/overlayModel" },
    ) as Record<string, unknown>;
    assert.equal(merged.model, "overlayProvider/overlayModel");
  });

  it("modelRef with no parent model selection produces output with model set", () => {
    const merged = mergeSubagentSpawnModelSelection(
      undefined,
      undefined,
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.ok(merged, "expected non-undefined output when modelRef is provided");
    assert.equal(merged.model, "newProvider/newModel");
  });

  it("modelRef with no parent and invocation overlay merges correctly", () => {
    const merged = mergeSubagentSpawnModelSelection(
      undefined,
      { thinking: { enabled: true, budgetTokens: 8000 }, reasoningEffort: "high" },
      "newProvider/newModel",
    ) as Record<string, unknown>;
    assert.equal(merged.model, "newProvider/newModel");
    assert.deepEqual(merged.thinking, { enabled: true, budgetTokens: 8000 });
    assert.equal(merged.reasoningEffort, "high");
  });
});
