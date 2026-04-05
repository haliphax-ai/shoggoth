import { describe, it } from "vitest";
import assert from "node:assert";
import { shoggothModelsCompactionSchema } from "../src/schema";

describe("shoggothModelsCompactionSchema contextWindowReserveTokens", () => {
  it("accepts valid contextWindowReserveTokens", () => {
    const result = shoggothModelsCompactionSchema.safeParse({
      maxContextChars: 80_000,
      preserveRecentMessages: 8,
      contextWindowReserveTokens: 20_000,
    });
    assert.ok(result.success);
    assert.equal(result.data!.contextWindowReserveTokens, 20_000);
  });

  it("accepts config without contextWindowReserveTokens", () => {
    const result = shoggothModelsCompactionSchema.safeParse({
      maxContextChars: 80_000,
      preserveRecentMessages: 8,
    });
    assert.ok(result.success);
    assert.equal(result.data!.contextWindowReserveTokens, undefined);
  });

  it("rejects contextWindowReserveTokens of 0", () => {
    const result = shoggothModelsCompactionSchema.safeParse({
      maxContextChars: 80_000,
      preserveRecentMessages: 8,
      contextWindowReserveTokens: 0,
    });
    assert.ok(!result.success);
  });

});
