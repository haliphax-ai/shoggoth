import assert from "node:assert";
import { describe, it } from "vitest";
import type { ShoggothConfig } from "../src/schema.js";
import { resolveContextLevel, validateContextLevel } from "../src/context-level.js";

function cfg(partial: Partial<ShoggothConfig>): ShoggothConfig {
  return partial as ShoggothConfig;
}

describe("resolveContextLevel", () => {
  // ── Defaults ──────────────────────────────────────────────────────────

  it("defaults to 'full' for top-level agents", () => {
    assert.equal(resolveContextLevel(cfg({}), "a"), "full");
    assert.equal(resolveContextLevel(cfg({}), "a", undefined, false), "full");
  });

  it("defaults to 'light' for subagents", () => {
    assert.equal(resolveContextLevel(cfg({}), "a", undefined, true), "light");
  });

  // ── Top-level config ─────────────────────────────────────────────────

  it("uses top-level agents.contextLevel for top-level agents", () => {
    const c = cfg({ agents: { contextLevel: "minimal" } });
    assert.equal(resolveContextLevel(c, "a"), "minimal");
  });

  it("uses top-level agents.subagentContextLevel for subagents", () => {
    const c = cfg({ agents: { subagentContextLevel: "none" } });
    assert.equal(resolveContextLevel(c, "a", undefined, true), "none");
  });

  it("top-level contextLevel does not affect subagents", () => {
    const c = cfg({ agents: { contextLevel: "none" } });
    assert.equal(resolveContextLevel(c, "a", undefined, true), "light");
  });

  it("top-level subagentContextLevel does not affect top-level agents", () => {
    const c = cfg({ agents: { subagentContextLevel: "none" } });
    assert.equal(resolveContextLevel(c, "a", undefined, false), "full");
  });

  // ── Per-agent config ─────────────────────────────────────────────────

  it("per-agent contextLevel overrides top-level for top-level agents", () => {
    const c = cfg({
      agents: {
        contextLevel: "full",
        list: { alice: { contextLevel: "minimal" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice"), "minimal");
  });

  it("per-agent subagentContextLevel overrides top-level for subagents", () => {
    const c = cfg({
      agents: {
        subagentContextLevel: "light",
        list: { alice: { subagentContextLevel: "none" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice", undefined, true), "none");
  });

  it("per-agent config for unknown agent falls through to top-level", () => {
    const c = cfg({
      agents: {
        contextLevel: "minimal",
        list: { alice: { contextLevel: "none" } },
      },
    });
    assert.equal(resolveContextLevel(c, "bob"), "minimal");
  });

  it("per-agent contextLevel does not affect subagent resolution", () => {
    const c = cfg({
      agents: {
        list: { alice: { contextLevel: "none" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice", undefined, true), "light");
  });

  it("per-agent subagentContextLevel does not affect top-level resolution", () => {
    const c = cfg({
      agents: {
        list: { alice: { subagentContextLevel: "none" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice", undefined, false), "full");
  });

  // ── Spawn override ───────────────────────────────────────────────────

  it("spawn override wins over everything for top-level agents", () => {
    const c = cfg({
      agents: {
        contextLevel: "full",
        list: { alice: { contextLevel: "light" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice", "none", false), "none");
  });

  it("spawn override wins over everything for subagents", () => {
    const c = cfg({
      agents: {
        subagentContextLevel: "light",
        list: { alice: { subagentContextLevel: "minimal" } },
      },
    });
    assert.equal(resolveContextLevel(c, "alice", "full", true), "full");
  });

  // ── Full precedence chain ────────────────────────────────────────────

  it("full precedence chain for top-level agents", () => {
    // Only default
    assert.equal(resolveContextLevel(cfg({}), "a"), "full");

    // Top-level set
    const c1 = cfg({ agents: { contextLevel: "minimal" } });
    assert.equal(resolveContextLevel(c1, "a"), "minimal");

    // Per-agent overrides top-level
    const c2 = cfg({
      agents: {
        contextLevel: "minimal",
        list: { a: { contextLevel: "light" } },
      },
    });
    assert.equal(resolveContextLevel(c2, "a"), "light");

    // Spawn override overrides per-agent
    assert.equal(resolveContextLevel(c2, "a", "none"), "none");
  });

  it("full precedence chain for subagents", () => {
    // Only default
    assert.equal(resolveContextLevel(cfg({}), "a", undefined, true), "light");

    // Top-level set
    const c1 = cfg({ agents: { subagentContextLevel: "minimal" } });
    assert.equal(resolveContextLevel(c1, "a", undefined, true), "minimal");

    // Per-agent overrides top-level
    const c2 = cfg({
      agents: {
        subagentContextLevel: "minimal",
        list: { a: { subagentContextLevel: "none" } },
      },
    });
    assert.equal(resolveContextLevel(c2, "a", undefined, true), "none");

    // Spawn override overrides per-agent
    assert.equal(resolveContextLevel(c2, "a", "full", true), "full");
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it("handles empty agents.list gracefully", () => {
    const c = cfg({ agents: { list: {} } });
    assert.equal(resolveContextLevel(c, "a"), "full");
    assert.equal(resolveContextLevel(c, "a", undefined, true), "light");
  });

  it("handles agents with no context level fields", () => {
    const c = cfg({ agents: { list: { a: {} } } });
    assert.equal(resolveContextLevel(c, "a"), "full");
    assert.equal(resolveContextLevel(c, "a", undefined, true), "light");
  });
});

describe("validateContextLevel", () => {
  it("accepts valid context levels", () => {
    assert.equal(validateContextLevel("none"), "none");
    assert.equal(validateContextLevel("minimal"), "minimal");
    assert.equal(validateContextLevel("light"), "light");
    assert.equal(validateContextLevel("full"), "full");
  });

  it("rejects invalid strings", () => {
    assert.throws(() => validateContextLevel("invalid"), /Expected/);
    assert.throws(() => validateContextLevel(""), /Expected/);
    assert.throws(() => validateContextLevel("FULL"), /Expected/);
  });

  it("rejects non-string values", () => {
    assert.throws(() => validateContextLevel(42), /Expected/);
    assert.throws(() => validateContextLevel(null), /Expected/);
    assert.throws(() => validateContextLevel(undefined), /Expected/);
    assert.throws(() => validateContextLevel(true), /Expected/);
  });
});
