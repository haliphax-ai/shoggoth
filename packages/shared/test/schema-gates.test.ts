// ---------------------------------------------------------------------------
// gates config schema — `gates.agentsMd.tools` / `gates.reRead.tools` glob
// lists for the system gates (AGENTS.md discovery, re-read-required).
//
// RED today: `shoggothGatesConfigSchema` / `DEFAULT_GATES_CONFIG` are not
// exported yet, and the strict fragment/full config schemas reject the unknown
// `gates` key. GREEN adds `packages/shared/src/schema/gates.ts`, plumbs it
// into `sharedConfigFields` + `defaultConfig()`, and re-exports from both
// barrels.
// ---------------------------------------------------------------------------
import { describe, it } from "vitest";
import assert from "node:assert";
import {
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  defaultConfig,
  shoggothGatesConfigSchema,
  DEFAULT_GATES_CONFIG,
  type ShoggothGatesConfig,
} from "../src/schema";

// ---------------------------------------------------------------------------
// shoggothGatesConfigSchema
// ---------------------------------------------------------------------------
describe("shoggothGatesConfigSchema", () => {
  it("accepts a full gates config", () => {
    const r = shoggothGatesConfigSchema.safeParse({
      agentsMd: { tools: ["demo_ext-*", "filesystem-write"] },
      reRead: { tools: ["demo_ext-edit"] },
    });
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("defaults an omitted gate to empty tools", () => {
    const r = shoggothGatesConfigSchema.safeParse({
      agentsMd: { tools: ["demo_ext-*"] },
    });
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
    assert.deepEqual(r.data!.reRead.tools, []);
  });

  it("accepts an empty config and defaults both gates", () => {
    const cfg: ShoggothGatesConfig = shoggothGatesConfigSchema.parse({});
    assert.deepEqual(cfg.agentsMd.tools, []);
    assert.deepEqual(cfg.reRead.tools, []);
  });

  it("rejects a non-string tools entry", () => {
    assert.ok(!shoggothGatesConfigSchema.safeParse({ agentsMd: { tools: [1] } }).success);
  });

  it("rejects an empty pattern string", () => {
    assert.ok(!shoggothGatesConfigSchema.safeParse({ agentsMd: { tools: [""] } }).success);
  });

  it("rejects unknown top-level gate keys (strict)", () => {
    assert.ok(!shoggothGatesConfigSchema.safeParse({ bogus: { tools: [] } } as any).success);
  });

  it("rejects unknown sub-keys inside a gate (strict)", () => {
    assert.ok(
      !shoggothGatesConfigSchema.safeParse({ agentsMd: { tools: [], nope: 1 } } as any).success,
    );
  });
});

describe("DEFAULT_GATES_CONFIG", () => {
  it("has empty tool lists for both gates", () => {
    assert.deepEqual(DEFAULT_GATES_CONFIG, {
      agentsMd: { tools: [] },
      reRead: { tools: [] },
    });
  });
});

// ---------------------------------------------------------------------------
// gates in the config fragment schema
// ---------------------------------------------------------------------------
describe("gates in config fragment schema", () => {
  it("accepts gates in a fragment; omitted reRead defaults to empty tools", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      gates: { agentsMd: { tools: ["demo_ext-*"] } },
    });
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
    assert.deepEqual((r.data as any).gates?.agentsMd?.tools, ["demo_ext-*"]);
    assert.deepEqual((r.data as any).gates?.reRead?.tools, []);
  });

  it("accepts both gates with explicit tools", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      gates: {
        agentsMd: { tools: ["demo_ext-*"] },
        reRead: { tools: ["filesystem-write"] },
      },
    });
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("rejects gates with non-string tools", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      gates: { agentsMd: { tools: [1] } },
    });
    assert.ok(!r.success);
  });

  it("rejects gates with an unknown gate name (strict)", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      gates: { agentsMd: { tools: [] }, nope: { tools: [] } },
    });
    assert.ok(!r.success);
  });

  it("rejects gates with an unknown sub-key (strict)", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      gates: { bogus: {} },
    });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// gates through the full shoggothConfigSchema / defaultConfig
// ---------------------------------------------------------------------------
describe("gates in full config schema / defaultConfig", () => {
  function fullConfigWith(overrides: Record<string, unknown>) {
    return { ...defaultConfig("/etc/shoggoth/config.d"), ...overrides };
  }

  it("defaultConfig includes DEFAULT_GATES_CONFIG", () => {
    const cfg = defaultConfig("/etc/shoggoth/config.d");
    assert.deepEqual((cfg as any).gates, DEFAULT_GATES_CONFIG);
  });

  it("parses default config (gates present, feature off)", () => {
    const r = shoggothConfigSchema.safeParse(defaultConfig("/etc/shoggoth/config.d"));
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("parses full config with custom gates", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        gates: { agentsMd: { tools: ["demo_ext-*"] }, reRead: { tools: [] } },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
    assert.deepEqual((r.data as any).gates?.agentsMd?.tools, ["demo_ext-*"]);
    assert.deepEqual((r.data as any).gates?.reRead?.tools, []);
  });

  it("rejects unknown keys inside gates through the full config schema", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({ gates: { agentsMd: { tools: ["demo_ext-*"], bogus: 1 } } }),
    );
    assert.ok(!r.success);
  });
});
