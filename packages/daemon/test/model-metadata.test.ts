/**
 * Unit tests for model-metadata store.
 *
 * Every test creates an isolated store via createModelMetadataStore()
 * so tests never share mutable state.
 */
import { describe, it, expect } from "vitest";
import {
  createModelMetadataStore,
  initModelMetadataFromConfig,
  setModelMetadataFromProvider,
  getModelContextWindowTokens,
  registerAnthropicDefaultsForProviders,
  registerOpenAIDefaultsForProviders,
  getOpenAIKnownContextWindow,
} from "../src/model-metadata";

describe("model-metadata", () => {
  // ── createModelMetadataStore ────────────────────────────────────────

  describe("createModelMetadataStore", () => {
    it("returns an empty Map", () => {
      const store = createModelMetadataStore();
      expect(store).toBeInstanceOf(Map);
      expect(store.size).toBe(0);
    });

    it("each call returns a distinct instance", () => {
      const a = createModelMetadataStore();
      const b = createModelMetadataStore();
      expect(a).not.toBe(b);
    });
  });

  // ── initModelMetadataFromConfig ─────────────────────────────────────

  describe("initModelMetadataFromConfig", () => {
    it("populates store from failover chain + providers config", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(
        ["prov1/gpt-4o", "prov2/claude-3"],
        [
          {
            id: "prov1",
            models: [{ name: "gpt-4o", contextWindowTokens: 128_000 }],
          },
          {
            id: "prov2",
            models: [{ name: "claude-3", contextWindowTokens: 200_000 }],
          },
        ],
        store,
      );

      expect(getModelContextWindowTokens("prov1", "gpt-4o", store)).toBe(128_000);
      expect(getModelContextWindowTokens("prov2", "claude-3", store)).toBe(200_000);
    });

    it("skips entries without contextWindowTokens", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(
        ["prov1/gpt-4o"],
        [{ id: "prov1", models: [{ name: "gpt-4o" }] }],
        store,
      );

      expect(store.size).toBe(0);
    });

    it("skips entries with malformed failover chain (no slash)", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(["badentry"], [], store);
      expect(store.size).toBe(0);
    });

    it("skips providers not found in the failover chain", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(
        ["prov1/gpt-4o"],
        [
          {
            id: "provOther",
            models: [{ name: "x", contextWindowTokens: 999 }],
          },
        ],
        store,
      );

      expect(store.size).toBe(0);
    });

    it("works without providers array", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(["prov1/gpt-4o"], undefined, store);
      expect(store.size).toBe(0);
    });
  });

  // ── setModelMetadataFromProvider ────────────────────────────────────

  describe("setModelMetadataFromProvider", () => {
    it("sets metadata with source 'provider'", () => {
      const store = createModelMetadataStore();
      setModelMetadataFromProvider("openai", "gpt-4o", 128_000, store);

      expect(getModelContextWindowTokens("openai", "gpt-4o", store)).toBe(128_000);
      const entry = store.get("openai:gpt-4o");
      expect(entry?.source).toBe("provider");
    });

    it("overwrites existing provider metadata", () => {
      const store = createModelMetadataStore();
      setModelMetadataFromProvider("openai", "gpt-4o", 128_000, store);
      setModelMetadataFromProvider("openai", "gpt-4o", 200_000, store);

      expect(getModelContextWindowTokens("openai", "gpt-4o", store)).toBe(200_000);
    });

    it("returns warning when config value differs from provider value", () => {
      const store = createModelMetadataStore();
      // Seed with a config-sourced entry
      store.set("openai:gpt-4o", {
        contextWindowTokens: 128_000,
        source: "config",
      });

      const warning = setModelMetadataFromProvider("openai", "gpt-4o", 200_000, store);

      expect(warning).toContain("mismatch");
      expect(warning).toContain("openai:gpt-4o");
    });

    it("returns undefined when no prior config value exists", () => {
      const store = createModelMetadataStore();
      const warning = setModelMetadataFromProvider("openai", "gpt-4o", 128_000, store);

      expect(warning).toBeUndefined();
    });

    it("returns undefined when config value matches provider value", () => {
      const store = createModelMetadataStore();
      store.set("openai:gpt-4o", {
        contextWindowTokens: 128_000,
        source: "config",
      });

      const warning = setModelMetadataFromProvider("openai", "gpt-4o", 128_000, store);

      expect(warning).toBeUndefined();
    });
  });

  // ── getModelContextWindowTokens ─────────────────────────────────────

  describe("getModelContextWindowTokens", () => {
    it("returns the context window tokens for a known model", () => {
      const store = createModelMetadataStore();
      store.set("anthropic:claude-3", {
        contextWindowTokens: 200_000,
        source: "default",
      });

      expect(getModelContextWindowTokens("anthropic", "claude-3", store)).toBe(200_000);
    });

    it("returns undefined for unknown models", () => {
      const store = createModelMetadataStore();
      expect(getModelContextWindowTokens("nonexistent", "model", store)).toBeUndefined();
    });
  });

  // ── registerAnthropicDefaultsForProviders ───────────────────────────

  describe("registerAnthropicDefaultsForProviders", () => {
    it("registers 200k defaults for anthropic-messages providers", () => {
      const store = createModelMetadataStore();
      registerAnthropicDefaultsForProviders([{ id: "anth1", kind: "anthropic-messages" }], store);

      expect(getModelContextWindowTokens("anth1", "claude-sonnet-4-20250514", store)).toBe(200_000);
      expect(getModelContextWindowTokens("anth1", "claude-3-haiku-20240307", store)).toBe(200_000);
    });

    it("does not register defaults for non-anthropic providers", () => {
      const store = createModelMetadataStore();
      registerAnthropicDefaultsForProviders([{ id: "openai1", kind: "openai-compatible" }], store);

      expect(store.size).toBe(0);
    });

    it("does not overwrite existing config or provider entries", () => {
      const store = createModelMetadataStore();
      store.set("anth1:claude-sonnet-4-20250514", {
        contextWindowTokens: 100_000,
        source: "config",
      });

      registerAnthropicDefaultsForProviders([{ id: "anth1", kind: "anthropic-messages" }], store);

      expect(getModelContextWindowTokens("anth1", "claude-sonnet-4-20250514", store)).toBe(100_000);
    });
  });

  // ── registerOpenAIDefaultsForProviders ──────────────────────────────

  describe("registerOpenAIDefaultsForProviders", () => {
    it("registers known context windows for openai-compatible providers in the failover chain", () => {
      const store = createModelMetadataStore();
      registerOpenAIDefaultsForProviders(
        [{ id: "oai1", kind: "openai-compatible" }],
        ["oai1/gpt-4o", "oai1/gpt-4"],
        store,
      );

      expect(getModelContextWindowTokens("oai1", "gpt-4o", store)).toBe(128_000);
      expect(getModelContextWindowTokens("oai1", "gpt-4", store)).toBe(8_192);
    });

    it("does not register defaults for models not in the failover chain", () => {
      const store = createModelMetadataStore();
      registerOpenAIDefaultsForProviders(
        [{ id: "oai1", kind: "openai-compatible" }],
        ["oai1/gpt-4o"],
        store,
      );

      expect(getModelContextWindowTokens("oai1", "gpt-4", store)).toBeUndefined();
    });

    it("does not register defaults for non-openai providers", () => {
      const store = createModelMetadataStore();
      registerOpenAIDefaultsForProviders(
        [{ id: "anth1", kind: "anthropic-messages" }],
        ["anth1/gpt-4o"],
        store,
      );

      expect(store.size).toBe(0);
    });

    it("does not overwrite existing config or provider entries", () => {
      const store = createModelMetadataStore();
      store.set("oai1:gpt-4o", {
        contextWindowTokens: 99_999,
        source: "provider",
      });

      registerOpenAIDefaultsForProviders(
        [{ id: "oai1", kind: "openai-compatible" }],
        ["oai1/gpt-4o"],
        store,
      );

      expect(getModelContextWindowTokens("oai1", "gpt-4o", store)).toBe(99_999);
    });

    it("skips unknown models in the failover chain gracefully", () => {
      const store = createModelMetadataStore();
      registerOpenAIDefaultsForProviders(
        [{ id: "oai1", kind: "openai-compatible" }],
        ["oai1/unknown-model-xyz"],
        store,
      );

      expect(store.size).toBe(0);
    });
  });

  // ── getOpenAIKnownContextWindow ─────────────────────────────────────

  describe("getOpenAIKnownContextWindow", () => {
    it("returns known context window for recognized models", () => {
      expect(getOpenAIKnownContextWindow("gpt-4o")).toBe(128_000);
      expect(getOpenAIKnownContextWindow("gpt-4.1")).toBe(1_047_576);
      expect(getOpenAIKnownContextWindow("o3")).toBe(200_000);
      expect(getOpenAIKnownContextWindow("gpt-4")).toBe(8_192);
    });

    it("returns undefined for unrecognized models", () => {
      expect(getOpenAIKnownContextWindow("nonexistent-model")).toBeUndefined();
    });
  });

  // ── test isolation verification ─────────────────────────────────────

  describe("test isolation", () => {
    it("store from one test does not leak into another", () => {
      const store1 = createModelMetadataStore();
      setModelMetadataFromProvider("prov1", "model1", 100_000, store1);

      const store2 = createModelMetadataStore();
      expect(getModelContextWindowTokens("prov1", "model1", store2)).toBeUndefined();
      expect(store2.size).toBe(0);
    });
  });
});
