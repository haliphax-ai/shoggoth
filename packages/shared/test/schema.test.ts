import { describe, it } from "vitest";
import assert from "node:assert";
import {
  providerModelSchema,
  failoverChainEntrySchema,
  modelsRetrySchema,
  shoggothModelsConfigSchema,
} from "../src/schema";

// ---------------------------------------------------------------------------
// providerModelSchema
// ---------------------------------------------------------------------------
describe("providerModelSchema", () => {
  it("accepts a minimal model with just a name", () => {
    const r = providerModelSchema.safeParse({ name: "gpt-4o" });
    assert.ok(r.success);
    assert.equal(r.data!.name, "gpt-4o");
  });

  it("accepts all optional fields", () => {
    const r = providerModelSchema.safeParse({
      name: "claude-sonnet-4-20250514",
      contextWindowTokens: 200_000,
      thinkingFormat: "native",
    });
    assert.ok(r.success);
    assert.equal(r.data!.contextWindowTokens, 200_000);
    assert.equal(r.data!.thinkingFormat, "native");
  });

  it("rejects empty name", () => {
    const r = providerModelSchema.safeParse({ name: "" });
    assert.ok(!r.success);
  });

  it("rejects non-positive contextWindowTokens", () => {
    assert.ok(!providerModelSchema.safeParse({ name: "m", contextWindowTokens: 0 }).success);
    assert.ok(!providerModelSchema.safeParse({ name: "m", contextWindowTokens: -1 }).success);
  });

  it("rejects invalid thinkingFormat", () => {
    assert.ok(!providerModelSchema.safeParse({ name: "m", thinkingFormat: "bad" }).success);
  });

  it("accepts all valid thinkingFormat values", () => {
    for (const fmt of ["native", "xml-tags", "none"] as const) {
      assert.ok(providerModelSchema.safeParse({ name: "m", thinkingFormat: fmt }).success);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider schema: models array + retry fields
// ---------------------------------------------------------------------------
describe("provider schema with models and retry fields", () => {
  const baseProvider = {
    id: "my-provider",
    kind: "openai-compatible" as const,
    baseUrl: "https://api.example.com",
  };

  it("accepts provider with models array", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{ ...baseProvider, models: [{ name: "gpt-4o" }] }],
    });
    assert.ok(r.success);
    assert.equal(r.data!.providers![0].models![0].name, "gpt-4o");
  });

  it("accepts provider without models (optional)", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [baseProvider],
    });
    assert.ok(r.success);
    assert.equal(r.data!.providers![0].models, undefined);
  });

  it("accepts provider with per-provider retry fields", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{
        ...baseProvider,
        maxRetries: 3,
        retryDelayMs: 1000,
        retryBackoffMultiplier: 2.0,
        markFailedDurationMs: 60_000,
      }],
    });
    assert.ok(r.success);
    const p = r.data!.providers![0];
    assert.equal(p.maxRetries, 3);
    assert.equal(p.retryDelayMs, 1000);
    assert.equal(p.retryBackoffMultiplier, 2.0);
    assert.equal(p.markFailedDurationMs, 60_000);
  });

  it("rejects negative maxRetries on provider", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{ ...baseProvider, maxRetries: -1 }],
    });
    assert.ok(!r.success);
  });

  it("rejects non-positive retryBackoffMultiplier on provider", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{ ...baseProvider, retryBackoffMultiplier: 0 }],
    });
    assert.ok(!r.success);
  });

  it("rejects non-positive markFailedDurationMs on provider", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{ ...baseProvider, markFailedDurationMs: 0 }],
    });
    assert.ok(!r.success);
  });

  it("works with anthropic-messages provider too", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{
        id: "anthropic",
        kind: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        models: [{ name: "claude-sonnet-4-20250514", contextWindowTokens: 200_000, thinkingFormat: "native" }],
        maxRetries: 2,
      }],
    });
    assert.ok(r.success);
  });

  it("works with gemini provider too", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [{
        id: "gemini",
        kind: "gemini",
        models: [{ name: "gemini-2.5-pro" }],
        retryDelayMs: 500,
      }],
    });
    assert.ok(r.success);
  });
});

// ---------------------------------------------------------------------------
// failoverChainEntrySchema
// ---------------------------------------------------------------------------
describe("failoverChainEntrySchema", () => {
  it("accepts a plain string ref", () => {
    const r = failoverChainEntrySchema.safeParse("anthropic/claude-sonnet-4-20250514");
    assert.ok(r.success);
    assert.equal(r.data, "anthropic/claude-sonnet-4-20250514");
  });

  it("accepts an object with ref", () => {
    const r = failoverChainEntrySchema.safeParse({ ref: "openai/gpt-4o" });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data, { ref: "openai/gpt-4o" });
  });

  it("rejects empty string", () => {
    assert.ok(!failoverChainEntrySchema.safeParse("").success);
  });

  it("rejects object with empty ref", () => {
    assert.ok(!failoverChainEntrySchema.safeParse({ ref: "" }).success);
  });

  it("rejects object without ref", () => {
    assert.ok(!failoverChainEntrySchema.safeParse({}).success);
  });

  it("works inside modelsConfig failoverChain", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      failoverChain: [
        "anthropic/claude-sonnet-4-20250514",
        { ref: "openai/gpt-4o" },
      ],
    });
    assert.ok(r.success);
    assert.equal(r.data!.failoverChain!.length, 2);
  });
});

// ---------------------------------------------------------------------------
// modelsRetrySchema
// ---------------------------------------------------------------------------
describe("modelsRetrySchema", () => {
  it("accepts empty object (all optional)", () => {
    const r = modelsRetrySchema.safeParse({});
    assert.ok(r.success);
  });

  it("accepts all fields", () => {
    const r = modelsRetrySchema.safeParse({
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 1.5,
      markFailedDurationMs: 60_000,
    });
    assert.ok(r.success);
    assert.equal(r.data!.maxRetries, 3);
    assert.equal(r.data!.retryDelayMs, 1000);
    assert.equal(r.data!.retryBackoffMultiplier, 1.5);
    assert.equal(r.data!.markFailedDurationMs, 60_000);
  });

  it("accepts maxRetries of 0", () => {
    assert.ok(modelsRetrySchema.safeParse({ maxRetries: 0 }).success);
  });

  it("rejects negative maxRetries", () => {
    assert.ok(!modelsRetrySchema.safeParse({ maxRetries: -1 }).success);
  });

  it("accepts retryDelayMs of 0", () => {
    assert.ok(modelsRetrySchema.safeParse({ retryDelayMs: 0 }).success);
  });

  it("rejects negative retryDelayMs", () => {
    assert.ok(!modelsRetrySchema.safeParse({ retryDelayMs: -1 }).success);
  });

  it("rejects non-positive retryBackoffMultiplier", () => {
    assert.ok(!modelsRetrySchema.safeParse({ retryBackoffMultiplier: 0 }).success);
    assert.ok(!modelsRetrySchema.safeParse({ retryBackoffMultiplier: -1 }).success);
  });

  it("rejects non-positive markFailedDurationMs", () => {
    assert.ok(!modelsRetrySchema.safeParse({ markFailedDurationMs: 0 }).success);
  });

  it("is available on modelsConfig as retry field", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      retry: {
        maxRetries: 5,
        retryDelayMs: 2000,
        retryBackoffMultiplier: 2.0,
        markFailedDurationMs: 120_000,
      },
    });
    assert.ok(r.success);
    assert.equal(r.data!.retry!.maxRetries, 5);
  });
});
