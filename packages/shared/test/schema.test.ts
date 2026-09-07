import { describe, it } from "vitest";
import assert from "node:assert";
import {
  shoggothMemoryConfigSchema,
  DEFAULT_MEMORY_CONFIG,
  providerModelSchema,
  failoverChainEntrySchema,
  modelsRetrySchema,
  shoggothModelsConfigSchema,
  shoggothAgentEntrySchema,
  shoggothAgentsConfigSchema,
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  defaultConfig,
} from "../src/schema";

// ---------------------------------------------------------------------------
// shoggothMemoryConfigSchema — workspace-relative paths
// ---------------------------------------------------------------------------
describe("shoggothMemoryConfigSchema", () => {
  it("accepts workspace-relative paths", () => {
    const r = shoggothMemoryConfigSchema.safeParse({
      paths: ["memory", "notes/daily"],
      embeddings: { enabled: false },
    });
    assert.ok(r.success);
  });

  it("rejects absolute paths", () => {
    const r = shoggothMemoryConfigSchema.safeParse({
      paths: ["/var/lib/shoggoth/workspaces/main/memory"],
      embeddings: { enabled: false },
    });
    assert.ok(!r.success);
  });

  it("rejects paths starting with /", () => {
    const r = shoggothMemoryConfigSchema.safeParse({
      paths: ["/etc/something"],
      embeddings: { enabled: false },
    });
    assert.ok(!r.success);
  });

  it("accepts empty paths array", () => {
    const r = shoggothMemoryConfigSchema.safeParse({
      paths: [],
      embeddings: { enabled: false },
    });
    assert.ok(r.success);
  });
});

describe("DEFAULT_MEMORY_CONFIG", () => {
  it('defaults paths to ["memory"]', () => {
    assert.deepEqual(DEFAULT_MEMORY_CONFIG.paths, ["memory"]);
  });
});

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
      providers: [
        {
          ...baseProvider,
          maxRetries: 3,
          retryDelayMs: 1000,
          retryBackoffMultiplier: 2.0,
          markFailedDurationMs: 60_000,
        },
      ],
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
      providers: [
        {
          id: "anthropic",
          kind: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          models: [
            {
              name: "claude-sonnet-4-20250514",
              contextWindowTokens: 200_000,
              thinkingFormat: "native",
            },
          ],
          maxRetries: 2,
        },
      ],
    });
    assert.ok(r.success);
  });

  it("works with gemini provider too", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      providers: [
        {
          id: "gemini",
          kind: "gemini",
          models: [{ name: "gemini-2.5-pro" }],
          retryDelayMs: 500,
        },
      ],
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

  it("rejects empty string", () => {
    assert.ok(!failoverChainEntrySchema.safeParse("").success);
  });

  it("works inside modelsConfig failoverChain", () => {
    const r = shoggothModelsConfigSchema.safeParse({
      failoverChain: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"],
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

// ---------------------------------------------------------------------------
// subagentModel on agent entry and agents config
// ---------------------------------------------------------------------------
describe("subagentModel schema field", () => {
  it("accepts subagentModel on shoggothAgentEntrySchema", () => {
    const r = shoggothAgentEntrySchema.safeParse({
      subagentModel: "anthropic/claude-3-5-haiku-20241022",
    });
    assert.ok(r.success);
    assert.equal(r.data!.subagentModel, "anthropic/claude-3-5-haiku-20241022");
  });

  it("accepts agent entry without subagentModel (optional)", () => {
    const r = shoggothAgentEntrySchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data!.subagentModel, undefined);
  });

  it("rejects empty string subagentModel on agent entry", () => {
    const r = shoggothAgentEntrySchema.safeParse({ subagentModel: "" });
    assert.ok(!r.success);
  });

  it("accepts subagentModel on shoggothAgentsConfigSchema", () => {
    const r = shoggothAgentsConfigSchema.safeParse({
      subagentModel: "openai/gpt-4o",
    });
    assert.ok(r.success);
    assert.equal(r.data!.subagentModel, "openai/gpt-4o");
  });

  it("accepts agents config without subagentModel (optional)", () => {
    const r = shoggothAgentsConfigSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data!.subagentModel, undefined);
  });

  it("rejects empty string subagentModel on agents config", () => {
    const r = shoggothAgentsConfigSchema.safeParse({ subagentModel: "" });
    assert.ok(!r.success);
  });

  it("accepts both global and per-agent subagentModel together", () => {
    const r = shoggothAgentsConfigSchema.safeParse({
      subagentModel: "openai/gpt-4o",
      list: {
        main: {
          subagentModel: "anthropic/claude-3-5-haiku-20241022",
        },
      },
    });
    assert.ok(r.success);
    assert.equal(r.data!.subagentModel, "openai/gpt-4o");
    assert.equal(r.data!.list!.main!.subagentModel, "anthropic/claude-3-5-haiku-20241022");
  });
});

// ---------------------------------------------------------------------------
// platforms.attachmentHandling — config fragment schema
// ---------------------------------------------------------------------------
describe("platforms.attachmentHandling in config fragment schema", () => {
  it("accepts platforms.attachmentHandling with mode 'download'", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      platforms: {
        attachmentHandling: { mode: "download" },
      },
    });
    assert.ok(r.success);
  });

  it("accepts platforms.attachmentHandling with mode 'inline'", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      platforms: {
        attachmentHandling: { mode: "inline" },
      },
    });
    assert.ok(r.success);
  });

  it("accepts platforms.attachmentHandling with mode 'hybrid'", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      platforms: {
        attachmentHandling: { mode: "hybrid" },
      },
    });
    assert.ok(r.success);
  });

  it("rejects platforms.attachmentHandling with invalid mode 'bogus'", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      platforms: {
        attachmentHandling: { mode: "bogus" },
      },
    });
    assert.ok(!r.success);
  });

  it("accepts platforms with attachmentHandling alongside platform entries", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      platforms: {
        discord: { enabled: true },
        attachmentHandling: { mode: "hybrid" },
      },
    });
    assert.ok(r.success);
  });
});

// ---------------------------------------------------------------------------
// per-agent platforms.attachmentHandling — agent entry schema
// ---------------------------------------------------------------------------
describe("per-agent platforms.attachmentHandling", () => {
  it("accepts attachmentHandling on per-agent platforms", () => {
    const r = shoggothAgentEntrySchema.safeParse({
      platforms: {
        attachmentHandling: { mode: "hybrid" },
      },
    });
    assert.ok(r.success);
  });

  it("accepts per-agent platforms with attachmentHandling alongside platform overrides", () => {
    const r = shoggothAgentEntrySchema.safeParse({
      platforms: {
        discord: { routes: {} },
        attachmentHandling: { mode: "inline" },
      },
    });
    assert.ok(r.success);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: platforms.attachmentHandling through full shoggothConfigSchema
// ---------------------------------------------------------------------------
describe("attachmentHandling — full shoggothConfigSchema end-to-end", () => {
  function fullConfigWith(overrides: Record<string, unknown>) {
    return { ...defaultConfig("/etc/shoggoth/config.d"), ...overrides };
  }

  it("parses with mode 'download' on global platforms", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        platforms: {
          discord: { enabled: true },
          attachmentHandling: { mode: "download" },
        },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("parses with mode 'inline' on global platforms", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        platforms: {
          discord: { enabled: true },
          attachmentHandling: { mode: "inline" },
        },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("parses with mode 'hybrid' on global platforms", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        platforms: {
          discord: { enabled: true },
          attachmentHandling: { mode: "hybrid" },
        },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("parses with per-agent attachmentHandling override", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        platforms: {
          discord: { enabled: true },
          attachmentHandling: { mode: "download" },
        },
        agents: {
          list: {
            "vision-agent": {
              platforms: {
                attachmentHandling: { mode: "hybrid" },
              },
            },
          },
        },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("rejects invalid mode through full config schema", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        platforms: {
          discord: { enabled: true },
          attachmentHandling: { mode: "bogus" },
        },
      }),
    );
    assert.ok(!r.success);
  });

  it("parses default config without attachmentHandling (optional)", () => {
    const r = shoggothConfigSchema.safeParse(defaultConfig("/etc/shoggoth/config.d"));
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });
});

// ---------------------------------------------------------------------------
// fetch config — SSRF protection settings
// ---------------------------------------------------------------------------
describe("fetch config", () => {
  function fullConfigWith(overrides: Record<string, unknown>) {
    return { ...defaultConfig("/etc/shoggoth/config.d"), ...overrides };
  }

  it("accepts fetch with allowPrivateIps: true in full config", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        fetch: { allowPrivateIps: true },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
    assert.equal((r.data as any).fetch?.allowPrivateIps, true);
  });

  it("accepts fetch with privateIpAllowlist in full config", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        fetch: { privateIpAllowlist: ["myhost.local", "10.0.0.1"] },
      }),
    );
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
    assert.deepEqual((r.data as any).fetch?.privateIpAllowlist, ["myhost.local", "10.0.0.1"]);
  });

  it("accepts config without fetch (optional)", () => {
    const r = shoggothConfigSchema.safeParse(fullConfigWith({}));
    assert.ok(r.success, JSON.stringify((r as any).error?.issues));
  });

  it("rejects fetch with invalid allowPrivateIps type", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        fetch: { allowPrivateIps: "yes" },
      }),
    );
    assert.ok(!r.success);
  });

  it("rejects fetch with unknown keys (strict)", () => {
    const r = shoggothConfigSchema.safeParse(
      fullConfigWith({
        fetch: { bogusKey: true },
      }),
    );
    assert.ok(!r.success);
  });

  it("accepts fetch in config fragment schema", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      fetch: { allowPrivateIps: true, privateIpAllowlist: ["local.host"] },
    });
    assert.ok(r.success);
  });

  it("rejects fetch with invalid privateIpAllowlist type", () => {
    const r = shoggothConfigFragmentSchema.safeParse({
      fetch: { privateIpAllowlist: 123 },
    });
    assert.ok(!r.success);
  });
});
