import { describe, it } from "vitest";
import assert from "node:assert";
import {
  providerModelSchema,
  modelsRetrySchema,
  shoggothModelFailoverHopSchema,
  shoggothConfigFragmentSchema,
  shoggothAgentModelsOverrideSchema,
} from "../src/schema";

// ---------------------------------------------------------------------------
// providerModelSchema
// ---------------------------------------------------------------------------

describe("providerModelSchema", () => {
  it("accepts a minimal model definition", () => {
    const r = providerModelSchema.safeParse({ name: "claude-3-5-sonnet" });
    assert.ok(r.success);
    assert.equal(r.data!.name, "claude-3-5-sonnet");
  });

  it("accepts full model definition with all optional fields", () => {
    const r = providerModelSchema.safeParse({
      name: "claude-3-5-sonnet",
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
    const r = providerModelSchema.safeParse({ name: "m", contextWindowTokens: 0 });
    assert.ok(!r.success);
  });

  it("rejects invalid thinkingFormat", () => {
    const r = providerModelSchema.safeParse({ name: "m", thinkingFormat: "bad" });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// Provider schema — models array + retry/failure fields
// ---------------------------------------------------------------------------

describe("provider schema models array", () => {
  it("accepts openai-compatible provider with models array", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "kiro",
            kind: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            models: [{ name: "gpt-4o", contextWindowTokens: 128_000 }],
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts anthropic-messages provider with models and retry fields", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "ant",
            kind: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            models: [{ name: "claude-3-5-sonnet", contextWindowTokens: 200_000, thinkingFormat: "native" }],
            maxRetries: 3,
            retryDelayMs: 500,
            retryBackoffMultiplier: 2,
            markFailedDurationMs: 120_000,
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts gemini provider with models", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "gem",
            kind: "gemini",
            models: [{ name: "gemini-2.5-flash" }],
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });
});

// ---------------------------------------------------------------------------
// Failover chain entry — string ref format
// ---------------------------------------------------------------------------

describe("failover chain entry string ref", () => {
  it("accepts a string ref in failover chain", () => {
    const r = shoggothModelFailoverHopSchema.safeParse("kiro/gpt-4o");
    assert.ok(r.success);
  });

  it("accepts an object ref in failover chain", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({ ref: "kiro/gpt-4o" });
    assert.ok(r.success);
  });

  it("rejects empty string ref", () => {
    const r = shoggothModelFailoverHopSchema.safeParse("");
    assert.ok(!r.success);
  });

  it("still accepts legacy object format", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "kiro",
      model: "gpt-4o",
      contextWindowTokens: 128_000,
    });
    assert.ok(r.success);
  });
});

// ---------------------------------------------------------------------------
// modelsRetrySchema
// ---------------------------------------------------------------------------

describe("modelsRetrySchema", () => {
  it("accepts full retry config", () => {
    const r = modelsRetrySchema.safeParse({
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      markFailedDurationMs: 60_000,
    });
    assert.ok(r.success);
  });

  it("accepts empty object (all optional)", () => {
    const r = modelsRetrySchema.safeParse({});
    assert.ok(r.success);
  });

  it("rejects negative maxRetries", () => {
    const r = modelsRetrySchema.safeParse({ maxRetries: -1 });
    assert.ok(!r.success);
  });

  it("rejects zero markFailedDurationMs", () => {
    const r = modelsRetrySchema.safeParse({ markFailedDurationMs: 0 });
    assert.ok(!r.success);
  });

  it("rejects non-positive retryBackoffMultiplier", () => {
    const r = modelsRetrySchema.safeParse({ retryBackoffMultiplier: 0 });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// models.retry in config fragment
// ---------------------------------------------------------------------------

describe("models.retry in config fragment", () => {
  it("accepts retry config in models block", () => {
    const frag = {
      models: {
        retry: {
          maxRetries: 2,
          retryDelayMs: 1000,
          retryBackoffMultiplier: 2,
          markFailedDurationMs: 60_000,
        },
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });
});

// ---------------------------------------------------------------------------
// Agent failover chain with string refs
// ---------------------------------------------------------------------------

describe("agent failover chain string refs", () => {
  it("accepts agent models override with string ref failover chain", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: ["kiro/claude-3-5-sonnet", "kiro/gpt-4o"],
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });
});
