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
// providerModelSchema — comprehensive edge cases
// ---------------------------------------------------------------------------

describe("providerModelSchema edge cases", () => {
  it("accepts model with only name (minimal)", () => {
    const r = providerModelSchema.safeParse({ name: "gpt-4" });
    assert.ok(r.success);
    assert.equal(r.data!.name, "gpt-4");
    assert.equal(r.data!.contextWindowTokens, undefined);
    assert.equal(r.data!.thinkingFormat, undefined);
  });

  it("accepts model with contextWindowTokens only", () => {
    const r = providerModelSchema.safeParse({ name: "m", contextWindowTokens: 1 });
    assert.ok(r.success);
  });

  it("accepts model with thinkingFormat xml-tags", () => {
    const r = providerModelSchema.safeParse({ name: "m", thinkingFormat: "xml-tags" });
    assert.ok(r.success);
    assert.equal(r.data!.thinkingFormat, "xml-tags");
  });

  it("accepts model with thinkingFormat none", () => {
    const r = providerModelSchema.safeParse({ name: "m", thinkingFormat: "none" });
    assert.ok(r.success);
    assert.equal(r.data!.thinkingFormat, "none");
  });

  it("accepts large contextWindowTokens", () => {
    const r = providerModelSchema.safeParse({ name: "m", contextWindowTokens: 1_000_000 });
    assert.ok(r.success);
  });

  it("rejects missing name field", () => {
    const r = providerModelSchema.safeParse({ contextWindowTokens: 100 });
    assert.ok(!r.success);
  });

  it("rejects contextWindowTokens as negative", () => {
    const r = providerModelSchema.safeParse({ name: "m", contextWindowTokens: -1 });
    assert.ok(!r.success);
  });

  it("rejects contextWindowTokens as float", () => {
    const r = providerModelSchema.safeParse({ name: "m", contextWindowTokens: 100.5 });
    assert.ok(!r.success);
  });

  it("rejects invalid thinkingFormat value", () => {
    const r = providerModelSchema.safeParse({ name: "m", thinkingFormat: "invalid" });
    assert.ok(!r.success);
  });

  it("rejects extra unknown fields", () => {
    const r = providerModelSchema.safeParse({ name: "m", unknown: "field" });
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

  it("accepts openai-compatible with minimal fields", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts openai-compatible with all retry fields", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            maxRetries: 5,
            retryDelayMs: 100,
            retryBackoffMultiplier: 1.5,
            markFailedDurationMs: 300_000,
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts anthropic-messages with minimal fields", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "anthropic",
            kind: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts anthropic-messages with auth field", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "anthropic",
            kind: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            auth: "bearer",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts gemini with minimal fields", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "gemini",
            kind: "gemini",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("accepts gemini with baseUrl and apiVersion", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "gemini",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiVersion: "v1",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  });

  it("rejects provider with empty id", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
  });

  it("rejects provider with empty baseUrl", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
  });

  it("rejects provider with invalid auth value", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "anthropic",
            kind: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            auth: "invalid",
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
  });

  it("rejects provider with negative maxRetries", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            maxRetries: -1,
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
  });

  it("rejects provider with zero retryBackoffMultiplier", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            retryBackoffMultiplier: 0,
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
  });

  it("rejects provider with zero markFailedDurationMs", () => {
    const frag = {
      models: {
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            markFailedDurationMs: 0,
          },
        ],
      },
    };
    const r = shoggothConfigFragmentSchema.safeParse(frag);
    assert.ok(!r.success);
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
// shoggothModelFailoverHopSchema — comprehensive edge cases
// ---------------------------------------------------------------------------

describe("shoggothModelFailoverHopSchema edge cases", () => {
  it("accepts string ref with provider and model", () => {
    const r = shoggothModelFailoverHopSchema.safeParse("provider/model");
    assert.ok(r.success);
  });

  it("accepts string ref with complex model name", () => {
    const r = shoggothModelFailoverHopSchema.safeParse("kiro/gpt-4o-mini-2024-07-18");
    assert.ok(r.success);
  });

  it("accepts object with ref field", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({ ref: "provider/model" });
    assert.ok(r.success);
  });

  it("accepts legacy providerId/model object", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
    });
    assert.ok(r.success);
  });

  it("accepts legacy object with contextWindowTokens", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
      contextWindowTokens: 200_000,
    });
    assert.ok(r.success);
  });

  it("accepts legacy object with thinkingFormat", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
      thinkingFormat: "native",
    });
    assert.ok(r.success);
  });

  it("accepts legacy object with capabilities", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
      capabilities: {
        imageInput: true,
        thinkingFormat: "native",
      },
    });
    assert.ok(r.success);
  });

  it("rejects object with empty ref", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({ ref: "" });
    assert.ok(!r.success);
  });

  it("rejects legacy object missing providerId", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      model: "claude-3-5-sonnet",
    });
    assert.ok(!r.success);
  });

  it("rejects legacy object missing model", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
    });
    assert.ok(!r.success);
  });

  it("rejects legacy object with empty providerId", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "",
      model: "claude-3-5-sonnet",
    });
    assert.ok(!r.success);
  });

  it("rejects legacy object with empty model", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "",
    });
    assert.ok(!r.success);
  });

  it("rejects legacy object with negative contextWindowTokens", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
      contextWindowTokens: -1,
    });
    assert.ok(!r.success);
  });

  it("rejects legacy object with invalid thinkingFormat", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      providerId: "ant",
      model: "claude-3-5-sonnet",
      thinkingFormat: "invalid",
    });
    assert.ok(!r.success);
  });

  it("rejects object with extra unknown fields", () => {
    const r = shoggothModelFailoverHopSchema.safeParse({
      ref: "provider/model",
      unknown: "field",
    });
    assert.ok(!r.success);
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
// modelsRetrySchema — comprehensive edge cases
// ---------------------------------------------------------------------------

describe("modelsRetrySchema edge cases", () => {
  it("accepts maxRetries as 0", () => {
    const r = modelsRetrySchema.safeParse({ maxRetries: 0 });
    assert.ok(r.success);
  });

  it("accepts retryDelayMs as 0", () => {
    const r = modelsRetrySchema.safeParse({ retryDelayMs: 0 });
    assert.ok(r.success);
  });

  it("accepts retryBackoffMultiplier as 1", () => {
    const r = modelsRetrySchema.safeParse({ retryBackoffMultiplier: 1 });
    assert.ok(r.success);
  });

  it("accepts markFailedDurationMs as 1", () => {
    const r = modelsRetrySchema.safeParse({ markFailedDurationMs: 1 });
    assert.ok(r.success);
  });

  it("accepts large values", () => {
    const r = modelsRetrySchema.safeParse({
      maxRetries: 100,
      retryDelayMs: 1_000_000,
      retryBackoffMultiplier: 10,
      markFailedDurationMs: 86_400_000,
    });
    assert.ok(r.success);
  });

  it("rejects maxRetries as negative", () => {
    const r = modelsRetrySchema.safeParse({ maxRetries: -1 });
    assert.ok(!r.success);
  });

  it("rejects retryDelayMs as negative", () => {
    const r = modelsRetrySchema.safeParse({ retryDelayMs: -1 });
    assert.ok(!r.success);
  });

  it("rejects retryBackoffMultiplier as 0", () => {
    const r = modelsRetrySchema.safeParse({ retryBackoffMultiplier: 0 });
    assert.ok(!r.success);
  });

  it("rejects retryBackoffMultiplier as negative", () => {
    const r = modelsRetrySchema.safeParse({ retryBackoffMultiplier: -1 });
    assert.ok(!r.success);
  });

  it("rejects markFailedDurationMs as 0", () => {
    const r = modelsRetrySchema.safeParse({ markFailedDurationMs: 0 });
    assert.ok(!r.success);
  });

  it("rejects markFailedDurationMs as negative", () => {
    const r = modelsRetrySchema.safeParse({ markFailedDurationMs: -1 });
    assert.ok(!r.success);
  });

  it("rejects float values for integer fields", () => {
    const r = modelsRetrySchema.safeParse({ maxRetries: 3.5 });
    assert.ok(!r.success);
  });

  it("rejects extra unknown fields", () => {
    const r = modelsRetrySchema.safeParse({ maxRetries: 3, unknown: "field" });
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

// ---------------------------------------------------------------------------
// Agent models override — comprehensive validation
// ---------------------------------------------------------------------------

describe("agent models override comprehensive validation", () => {
  it("accepts failoverChain with single entry", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: ["provider/model"],
    });
    assert.ok(r.success);
  });

  it("accepts failoverChain with multiple entries", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: ["provider1/model1", "provider2/model2", "provider3/model3"],
    });
    assert.ok(r.success);
  });

  it("accepts failoverChain with mixed string and object refs", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: ["provider1/model1", { ref: "provider2/model2" }],
    });
    assert.ok(r.success);
  });

  it("accepts primary as string ref", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      primary: "provider/model",
    });
    assert.ok(r.success);
  });

  it("accepts primary as object ref", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      primary: { ref: "provider/model" },
    });
    assert.ok(r.success);
  });

  it("rejects failoverChain as empty array", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: [],
    });
    assert.ok(!r.success);
  });

  it("rejects both primary and failoverChain", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      primary: "provider/model",
      failoverChain: ["provider/model"],
    });
    assert.ok(!r.success);
  });

  it("rejects failoverChain with empty string ref", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: [""],
    });
    assert.ok(!r.success);
  });

  it("rejects extra unknown fields", () => {
    const r = shoggothAgentModelsOverrideSchema.safeParse({
      failoverChain: ["provider/model"],
      unknown: "field",
    });
    assert.ok(!r.success);
  });
});
