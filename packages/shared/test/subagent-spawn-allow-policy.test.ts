import assert from "node:assert";
import { describe, it } from "vitest";
import type { ShoggothConfig } from "../src/schema.js";
import {
  agentMayInvokeSubagentSpawnByAllowlist,
  effectiveSubagentSpawnAllowedAgentIds,
  hasExplicitSubagentSpawnAllowConfig,
  mergeSubagentSpawnAllowPatterns,
} from "../src/subagent-spawn-allow-policy.js";

function cfg(partial: Partial<ShoggothConfig>): ShoggothConfig {
  return partial as ShoggothConfig;
}

describe("subagent spawn allowlist", () => {
  it("defaults to sender-only agent id when subagentSpawnAllow is absent", () => {
    assert.deepStrictEqual(effectiveSubagentSpawnAllowedAgentIds(cfg({}), "main"), ["main"]);
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(cfg({}), "main"), true);
    assert.equal(hasExplicitSubagentSpawnAllowConfig(cfg({}), "main"), false);
  });

  it("merges global and per-sender allow", () => {
    const c = cfg({
      subagentSpawnAllow: { allow: ["a"] },
      agents: { list: { b: { subagentSpawnAllow: { allow: ["b"] } } } },
    });
    assert.deepStrictEqual(mergeSubagentSpawnAllowPatterns(c, "b"), ["a", "b"]);
  });

  it("denies when allow is explicit but sender not listed", () => {
    const c = cfg({
      subagentSpawnAllow: { allow: ["main", "worker"] },
    });
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "other"), false);
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "main"), true);
  });

  it("allows any id when * is present", () => {
    const c = cfg({
      subagentSpawnAllow: { allow: ["*"] },
    });
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "anyone"), true);
  });

  it("empty merged allow denies when config was explicit", () => {
    const c = cfg({
      subagentSpawnAllow: { allow: [] },
    });
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "main"), false);
  });

  it("per-sender-only allow block is explicit for that id; others default to self-only", () => {
    const c = cfg({
      agents: { list: { onlyme: { subagentSpawnAllow: { allow: ["onlyme"] } } } },
    });
    assert.equal(hasExplicitSubagentSpawnAllowConfig(c, "onlyme"), true);
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "onlyme"), true);
    assert.equal(hasExplicitSubagentSpawnAllowConfig(c, "other"), false);
    assert.deepStrictEqual(effectiveSubagentSpawnAllowedAgentIds(c, "other"), ["other"]);
    assert.equal(agentMayInvokeSubagentSpawnByAllowlist(c, "other"), true);
  });
});
