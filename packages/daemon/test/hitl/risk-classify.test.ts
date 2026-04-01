import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyToolRisk, DEFAULT_TOOL_RISK } from "../../src/hitl/risk-classify";
import type { HitlRiskTier } from "@shoggoth/shared";

describe("classifyToolRisk", () => {
  it("uses per-tool map when present", () => {
    const map: Record<string, HitlRiskTier> = { ...DEFAULT_TOOL_RISK, exec: "caution" };
    assert.equal(classifyToolRisk("exec", map), "caution");
  });

  it("falls back to wildcard * in map", () => {
    const map: Record<string, HitlRiskTier> = { "*": "critical" };
    assert.equal(classifyToolRisk("unknown_tool", map), "critical");
  });

  it("uses default built-in map when overlay omits tool and *", () => {
    assert.equal(classifyToolRisk("read", {}), "safe");
    assert.equal(classifyToolRisk("write", {}), "caution");
    assert.equal(classifyToolRisk("exec", {}), "critical");
  });

  it("maps namespaced MCP tool names to default risk by original tool segment", () => {
    assert.equal(classifyToolRisk("builtin.read", {}), "safe");
    assert.equal(classifyToolRisk("builtin.write", {}), "caution");
    assert.equal(classifyToolRisk("builtin.exec", {}), "critical");
    assert.equal(classifyToolRisk("memory.search", {}), "safe");
    assert.equal(classifyToolRisk("memory.ingest", {}), "caution");
    assert.equal(classifyToolRisk("builtin.memory.search", {}), "safe");
    assert.equal(classifyToolRisk("builtin.memory.ingest", {}), "caution");
  });

  it("overlay wins over defaults for read", () => {
    const map: Record<string, HitlRiskTier> = { read: "critical" };
    assert.equal(classifyToolRisk("read", map), "critical");
  });

  it("classifies tool as never when configured", () => {
    const map: Record<string, HitlRiskTier> = { "builtin.exec": "never" };
    assert.equal(classifyToolRisk("builtin.exec", map), "never");
    assert.equal(classifyToolRisk("exec", map), "never");
  });
});
