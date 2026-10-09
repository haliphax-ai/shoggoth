import { describe, it } from "vitest";
import assert from "node:assert";
import {
  encodeModelSelectCustomId,
  decodeModelSelectCustomId,
  buildProviderSelectOptions,
  buildModelSelectOptions,
} from "../src/model-select";

// Inline type definitions for testing (will be moved to implementation in Phase 3)
interface ProviderModel {
  id: string;
  name: string;
}

interface ProviderConfig {
  id: string;
  name: string;
  models: ProviderModel[];
}

interface FailoverChainEntry {
  providerId: string;
  modelId: string;
}

describe("encodeModelSelectCustomId / decodeModelSelectCustomId", () => {
  it("round-trip: encode('provider') then decode → gets back { step: 'provider' }", () => {
    const encoded = encodeModelSelectCustomId("provider");
    const decoded = decodeModelSelectCustomId(encoded);
    assert.deepStrictEqual(decoded, {
      step: "provider",
      extra: undefined,
    });
  });

  it("round-trip with extra: encode('model', 'anthropic') → decode → { step: 'model', extra: 'anthropic' }", () => {
    const encoded = encodeModelSelectCustomId("model", "anthropic");
    const decoded = decodeModelSelectCustomId(encoded);
    assert.deepStrictEqual(decoded, {
      step: "model",
      extra: "anthropic",
    });
  });

  it("round-trip for custom_modal step", () => {
    const encoded = encodeModelSelectCustomId("custom_modal", "openai");
    const decoded = decodeModelSelectCustomId(encoded);
    assert.deepStrictEqual(decoded, {
      step: "custom_modal",
      extra: "openai",
    });
  });

  it("decode returns null for unrelated custom_id strings (e.g. 'other:thing')", () => {
    const decoded = decodeModelSelectCustomId("other:thing");
    assert.strictEqual(decoded, null);
  });

  it("decode returns null for empty string", () => {
    const decoded = decodeModelSelectCustomId("");
    assert.strictEqual(decoded, null);
  });

  it("decode returns null for malformed strings (missing step)", () => {
    const decoded = decodeModelSelectCustomId("model_select|");
    assert.strictEqual(decoded, null);
  });

  it("decode returns null for malformed strings (invalid step)", () => {
    const decoded = decodeModelSelectCustomId("model_select|bogus");
    assert.strictEqual(decoded, null);
  });
});

describe("buildProviderSelectOptions", () => {
  const mockProviders: ProviderConfig[] = [
    { id: "openai", name: "OpenAI", models: [{ id: "gpt-4", name: "GPT-4" }] },
    { id: "anthropic", name: "Anthropic", models: [{ id: "claude-3", name: "Claude 3" }] },
    { id: "google", name: "Google", models: [{ id: "gemini", name: "Gemini" }] },
  ];

  it("returns (custom) as first option with value '__custom__'", () => {
    const options = buildProviderSelectOptions({
      providers: mockProviders,
      currentProviderId: undefined,
    });
    assert.strictEqual(options.length, 4); // 3 providers + 1 custom
    assert.strictEqual(options[0]!.label, "(custom)");
    assert.strictEqual(options[0]!.value, "__custom__");
    assert.strictEqual(options[0]!.default, undefined);
  });

  it("lists providers after (custom)", () => {
    const options = buildProviderSelectOptions({
      providers: mockProviders,
      currentProviderId: undefined,
    });
    assert.strictEqual(options[1]!.label, "OpenAI");
    assert.strictEqual(options[1]!.value, "openai");
    assert.strictEqual(options[2]!.label, "Anthropic");
    assert.strictEqual(options[2]!.value, "anthropic");
    assert.strictEqual(options[3]!.label, "Google");
    assert.strictEqual(options[3]!.value, "google");
  });

  it("marks currentProviderId as default: true", () => {
    const options = buildProviderSelectOptions({
      providers: mockProviders,
      currentProviderId: "anthropic",
    });
    const anthropicOption = options.find((o) => o.value === "anthropic");
    assert.ok(anthropicOption);
    assert.strictEqual(anthropicOption.default, true);
    // Ensure no other option has default: true
    const otherDefault = options.find((o) => o.value !== "anthropic" && o.default === true);
    assert.strictEqual(otherDefault, undefined);
  });

  it("no default when currentProviderId is undefined", () => {
    const options = buildProviderSelectOptions({
      providers: mockProviders,
      currentProviderId: undefined,
    });
    const defaultOptions = options.filter((o) => o.default === true);
    assert.strictEqual(defaultOptions.length, 0);
  });

  it("max 25 options total (24 providers + 1 custom); truncates if more", () => {
    const manyProviders: ProviderConfig[] = [];
    for (let i = 0; i < 30; i++) {
      manyProviders.push({
        id: `provider-${i}`,
        name: `Provider ${i}`,
        models: [],
      });
    }
    const options = buildProviderSelectOptions({
      providers: manyProviders,
      currentProviderId: undefined,
    });
    assert.strictEqual(options.length, 25); // 24 providers + 1 custom
    // First should be custom
    assert.strictEqual(options[0]!.value, "__custom__");
    // Last should be a provider (truncated)
    assert.strictEqual(options[24]!.value, "provider-23");
  });

  it("empty providers array → only (custom) option", () => {
    const options = buildProviderSelectOptions({
      providers: [],
      currentProviderId: undefined,
    });
    assert.strictEqual(options.length, 1);
    assert.strictEqual(options[0]!.label, "(custom)");
    assert.strictEqual(options[0]!.value, "__custom__");
  });
});

describe("buildModelSelectOptions", () => {
  const mockProviders: ProviderConfig[] = [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "gpt-4", name: "GPT-4" },
        { id: "gpt-3.5", name: "GPT-3.5" },
      ],
    },
    { id: "anthropic", name: "Anthropic", models: [{ id: "claude-3", name: "Claude 3" }] },
  ];

  it("lists models from provider.models[] array", () => {
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: mockProviders,
      failoverChain: [],
      currentModel: undefined,
    });
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0]!.value, "gpt-4");
    assert.strictEqual(options[1]!.value, "gpt-3.5");
  });

  it("also includes models from failoverChain entries matching the provider", () => {
    const failoverChain: FailoverChainEntry[] = [
      { providerId: "openai", modelId: "custom-model-1" },
      { providerId: "openai", modelId: "custom-model-2" },
      { providerId: "anthropic", modelId: "claude-3" },
    ];
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: mockProviders,
      failoverChain,
      currentModel: undefined,
    });
    assert.strictEqual(options.length, 4); // 2 from provider.models + 2 from failoverChain
    const values = options.map((o) => o.value);
    assert.ok(values.includes("gpt-4"));
    assert.ok(values.includes("gpt-3.5"));
    assert.ok(values.includes("custom-model-1"));
    assert.ok(values.includes("custom-model-2"));
  });

  it("deduplicates models appearing in both sources", () => {
    const failoverChain: FailoverChainEntry[] = [
      { providerId: "openai", modelId: "gpt-4" }, // duplicate
      { providerId: "openai", modelId: "custom-model" },
    ];
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: mockProviders,
      failoverChain,
      currentModel: undefined,
    });
    // Should have 3 unique models: gpt-4, gpt-3.5, custom-model
    assert.strictEqual(options.length, 3);
    const gpt4Options = options.filter((o) => o.value === "gpt-4");
    assert.strictEqual(gpt4Options.length, 1);
  });

  it("marks currentModel as default: true", () => {
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: mockProviders,
      failoverChain: [],
      currentModel: "gpt-3.5",
    });
    const gpt35Option = options.find((o) => o.value === "gpt-3.5");
    assert.ok(gpt35Option);
    assert.strictEqual(gpt35Option.default, true);
    // Ensure no other option has default: true
    const otherDefault = options.filter((o) => o.value !== "gpt-3.5" && o.default === true);
    assert.strictEqual(otherDefault.length, 0);
  });

  it("no default when currentModel is undefined", () => {
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: mockProviders,
      failoverChain: [],
      currentModel: undefined,
    });
    const defaultOptions = options.filter((o) => o.default === true);
    assert.strictEqual(defaultOptions.length, 0);
  });

  it("max 25 options; truncates if more", () => {
    const manyProviders: ProviderConfig[] = [
      {
        id: "openai",
        name: "OpenAI",
        models: Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })),
      },
    ];
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: manyProviders,
      failoverChain: [],
      currentModel: undefined,
    });
    assert.strictEqual(options.length, 25);
  });

  it("empty models → empty array", () => {
    const emptyProviders: ProviderConfig[] = [{ id: "openai", name: "OpenAI", models: [] }];
    const options = buildModelSelectOptions({
      providerId: "openai",
      providers: emptyProviders,
      failoverChain: [],
      currentModel: undefined,
    });
    assert.strictEqual(options.length, 0);
  });

  it("returns empty array when provider not found", () => {
    const options = buildModelSelectOptions({
      providerId: "nonexistent",
      providers: mockProviders,
      failoverChain: [],
      currentModel: undefined,
    });
    assert.strictEqual(options.length, 0);
  });
});
