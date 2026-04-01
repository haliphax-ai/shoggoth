import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyToolRisk, DEFAULT_TOOL_RISK } from "../../src/hitl/risk-classify";
import type { HitlRiskTier } from "@shoggoth/shared";

describe("classifyToolRisk", () => {
  it("uses per-tool map when present", () => {
    const map: Record<string, HitlRiskTier> = { ...DEFAULT_TOOL_RISK, "builtin.exec": "caution" };
    assert.equal(classifyToolRisk("builtin.exec", map), "caution");
  });

  it("falls back to wildcard * in map", () => {
    const map: Record<string, HitlRiskTier> = { "*": "critical" };
    assert.equal(classifyToolRisk("unknown_tool", map), "critical");
  });

  it("uses default built-in map for canonical tool names", () => {
    assert.equal(classifyToolRisk("builtin.read", {}), "safe");
    assert.equal(classifyToolRisk("builtin.write", {}), "caution");
    assert.equal(classifyToolRisk("builtin.exec", {}), "critical");
    assert.equal(classifyToolRisk("builtin.memory.search", {}), "safe");
    assert.equal(classifyToolRisk("builtin.memory.ingest", {}), "caution");
  });

  it("unknown tool names fall back to caution", () => {
    assert.equal(classifyToolRisk("unknown", {}), "caution");
    assert.equal(classifyToolRisk("read", {}), "caution");
  });

  it("overlay wins over defaults", () => {
    const map: Record<string, HitlRiskTier> = { "builtin.read": "critical" };
    assert.equal(classifyToolRisk("builtin.read", map), "critical");
  });

  it("classifies tool as never when configured", () => {
    const map: Record<string, HitlRiskTier> = { "builtin.exec": "never" };
    assert.equal(classifyToolRisk("builtin.exec", map), "never");
  });
});
