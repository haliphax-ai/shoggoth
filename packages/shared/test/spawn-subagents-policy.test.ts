import assert from "node:assert";
import { describe, it } from "vitest";
import type { ShoggothConfig } from "../src/schema.js";
import { effectiveSpawnSubagentsEnabled } from "../src/spawn-subagents-policy.js";

function cfg(partial: Partial<ShoggothConfig>): ShoggothConfig {
  return partial as ShoggothConfig;
}

describe("effectiveSpawnSubagentsEnabled", () => {
  it("defaults to true when unset", () => {
    assert.equal(effectiveSpawnSubagentsEnabled(cfg({}), "any"), true);
    assert.equal(effectiveSpawnSubagentsEnabled(cfg({}), undefined), true);
  });

  it("honors top-level spawnSubagents", () => {
    assert.equal(effectiveSpawnSubagentsEnabled(cfg({ spawnSubagents: false }), "a"), false);
    assert.equal(effectiveSpawnSubagentsEnabled(cfg({ spawnSubagents: true }), "a"), true);
  });

  it("per-agent overrides global when boolean", () => {
    const c = cfg({
      spawnSubagents: false,
      agents: { list: { alice: { spawnSubagents: true } } },
    });
    assert.equal(effectiveSpawnSubagentsEnabled(c, "alice"), true);
    assert.equal(effectiveSpawnSubagentsEnabled(c, "bob"), false);
  });

  it("falls back to global when per-agent spawnSubagents omitted", () => {
    const c = cfg({
      spawnSubagents: false,
      agents: { list: { alice: {} } },
    });
    assert.equal(effectiveSpawnSubagentsEnabled(c, "alice"), false);
  });
});
