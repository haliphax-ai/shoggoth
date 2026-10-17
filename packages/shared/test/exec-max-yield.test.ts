import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_EXEC_MAX_YIELD_MS } from "../src";
import { shoggothRuntimeConfigSchema } from "../src/schema/runtime";

describe("DEFAULT_EXEC_MAX_YIELD_MS", () => {
  it("is 30000 (30 seconds)", () => {
    assert.equal(DEFAULT_EXEC_MAX_YIELD_MS, 30_000);
  });
});

describe("runtime.execMaxYieldMs", () => {
  it("accepts a positive integer override", () => {
    const r = shoggothRuntimeConfigSchema.safeParse({ execMaxYieldMs: 5_000 });
    assert.ok(r.success);
  });

  it("rejects a non-positive value", () => {
    const r = shoggothRuntimeConfigSchema.safeParse({ execMaxYieldMs: 0 });
    assert.ok(!r.success);
  });
});
