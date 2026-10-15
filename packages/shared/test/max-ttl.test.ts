import assert from "node:assert";
import { describe, it } from "vitest";
import { DEFAULT_MAX_TTL_MS, clampTtlMs, resolveMaxTtlMs } from "../src/schema.js";
import { shoggothRuntimeConfigSchema } from "../src/schema/runtime.js";

describe("resolveMaxTtlMs", () => {
  it("defaults to DEFAULT_MAX_TTL_MS (24h) when unset", () => {
    assert.equal(resolveMaxTtlMs(undefined), DEFAULT_MAX_TTL_MS);
    assert.equal(DEFAULT_MAX_TTL_MS, 86_400_000);
  });

  it("defaults when runtime.maxTtlMs is absent", () => {
    assert.equal(resolveMaxTtlMs({ runtime: {} }), DEFAULT_MAX_TTL_MS);
  });

  it("uses runtime.maxTtlMs when set", () => {
    assert.equal(resolveMaxTtlMs({ runtime: { maxTtlMs: 3_600_000 } }), 3_600_000);
  });

  it("falls back to the default for invalid values", () => {
    assert.equal(resolveMaxTtlMs({ runtime: { maxTtlMs: 0 } }), DEFAULT_MAX_TTL_MS);
    assert.equal(resolveMaxTtlMs({ runtime: { maxTtlMs: -5 } }), DEFAULT_MAX_TTL_MS);
    assert.equal(resolveMaxTtlMs({ runtime: { maxTtlMs: Number.NaN } }), DEFAULT_MAX_TTL_MS);
  });
});

describe("clampTtlMs", () => {
  it("defaults an absent TTL to the max (never 'forever')", () => {
    assert.equal(clampTtlMs(undefined, 1000), 1000);
  });

  it("caps a provided TTL at the max", () => {
    assert.equal(clampTtlMs(5000, 1000), 1000);
  });

  it("passes through a provided TTL below the max", () => {
    assert.equal(clampTtlMs(500, 1000), 500);
  });

  it("returns exactly the max when the value equals it", () => {
    assert.equal(clampTtlMs(1000, 1000), 1000);
  });
});

describe("runtime.maxTtlMs schema", () => {
  it("accepts a positive integer", () => {
    const parsed = shoggothRuntimeConfigSchema.safeParse({ maxTtlMs: 3_600_000 });
    assert.ok(parsed.success);
  });

  it("rejects zero, negative, and non-integer values", () => {
    assert.ok(!shoggothRuntimeConfigSchema.safeParse({ maxTtlMs: 0 }).success);
    assert.ok(!shoggothRuntimeConfigSchema.safeParse({ maxTtlMs: -1 }).success);
    assert.ok(!shoggothRuntimeConfigSchema.safeParse({ maxTtlMs: 1.5 }).success);
  });
});
