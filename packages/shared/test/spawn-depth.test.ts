import assert from "node:assert";
import { describe, it } from "vitest";
import type { ShoggothConfig } from "../src/schema.js";
import {
  DEFAULT_MAX_SPAWN_DEPTH,
  computeSessionDepth,
  effectiveMaxSpawnDepth,
  maySpawnSubagentAtDepth,
} from "../src/spawn-depth.js";

function cfg(partial: Partial<ShoggothConfig>): ShoggothConfig {
  return partial as ShoggothConfig;
}

describe("effectiveMaxSpawnDepth", () => {
  it("defaults to 1 when unset", () => {
    assert.equal(DEFAULT_MAX_SPAWN_DEPTH, 1);
    assert.equal(effectiveMaxSpawnDepth(cfg({}), "any"), 1);
    assert.equal(effectiveMaxSpawnDepth(cfg({}), undefined), 1);
  });

  it("honors top-level maxSpawnDepth", () => {
    assert.equal(effectiveMaxSpawnDepth(cfg({ maxSpawnDepth: 0 }), "a"), 0);
    assert.equal(effectiveMaxSpawnDepth(cfg({ maxSpawnDepth: 2 }), "a"), 2);
  });

  it("per-agent overrides global when a valid non-negative integer", () => {
    const c = cfg({
      maxSpawnDepth: 1,
      agents: { list: { alice: { maxSpawnDepth: 3 } } },
    });
    assert.equal(effectiveMaxSpawnDepth(c, "alice"), 3);
    assert.equal(effectiveMaxSpawnDepth(c, "bob"), 1);
  });

  it("falls back to global when per-agent maxSpawnDepth omitted", () => {
    const c = cfg({
      maxSpawnDepth: 2,
      agents: { list: { alice: {} } },
    });
    assert.equal(effectiveMaxSpawnDepth(c, "alice"), 2);
  });

  it("ignores invalid per-agent values (negative / non-integer)", () => {
    const c = cfg({
      maxSpawnDepth: 2,
      agents: { list: { alice: { maxSpawnDepth: -1 } } },
    });
    assert.equal(effectiveMaxSpawnDepth(c, "alice"), 2);
    const f = cfg({
      agents: { list: { alice: { maxSpawnDepth: 1.5 } } },
    });
    assert.equal(effectiveMaxSpawnDepth(f, "alice"), 1);
  });

  it("ignores invalid top-level values (negative / non-integer)", () => {
    assert.equal(effectiveMaxSpawnDepth(cfg({ maxSpawnDepth: -1 }), "a"), 1);
    assert.equal(effectiveMaxSpawnDepth(cfg({ maxSpawnDepth: 2.5 }), "a"), 1);
  });
});

describe("computeSessionDepth", () => {
  it("top-level session (no parent) is depth 0", () => {
    const lookup = (_id: string): string | null => null;
    assert.equal(computeSessionDepth(lookup, "top"), 0);
  });

  it("counts each nested level", () => {
    const parents: Record<string, string | null> = {
      top: null,
      child: "top",
      grandchild: "child",
    };
    const lookup = (id: string): string | null | undefined => parents[id];
    assert.equal(computeSessionDepth(lookup, "top"), 0);
    assert.equal(computeSessionDepth(lookup, "child"), 1);
    assert.equal(computeSessionDepth(lookup, "grandchild"), 2);
  });

  it("returns -1 when a lineage row is missing", () => {
    const parents: Record<string, string | null> = { child: "gone" };
    const lookup = (id: string): string | null | undefined => parents[id];
    assert.equal(computeSessionDepth(lookup, "child"), -1);
    assert.equal(computeSessionDepth(lookup, "never-seen"), -1);
  });

  it("returns -1 on cycles", () => {
    const parents: Record<string, string | null> = { a: "b", b: "a" };
    const lookup = (id: string): string | null | undefined => parents[id];
    assert.equal(computeSessionDepth(lookup, "a"), -1);
  });
});

describe("maySpawnSubagentAtDepth", () => {
  it("default (max 1): depth 0 allowed, depth 1 denied", () => {
    assert.equal(maySpawnSubagentAtDepth(0, 1), true);
    assert.equal(maySpawnSubagentAtDepth(1, 1), false);
  });

  it("max 2: depth 1 allowed, depth 2 denied", () => {
    assert.equal(maySpawnSubagentAtDepth(1, 2), true);
    assert.equal(maySpawnSubagentAtDepth(2, 2), false);
  });

  it("max 0 disables spawning entirely", () => {
    assert.equal(maySpawnSubagentAtDepth(0, 0), false);
  });

  it("unresolvable depth (-1) is always denied", () => {
    assert.equal(maySpawnSubagentAtDepth(-1, 1), false);
    assert.equal(maySpawnSubagentAtDepth(-1, 99), false);
  });
});
