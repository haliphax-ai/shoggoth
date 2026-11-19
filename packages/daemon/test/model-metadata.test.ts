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
            models: { "gpt-4o": { contextWindowTokens: 128_000 } },
          },
          {
            id: "prov2",
            models: { "claude-3": { contextWindowTokens: 200_000 } },
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
        [{ id: "prov1", models: { "gpt-4o": {} } }],
        store,
      );

      expect(store.size).toBe(0);
    });

    it("skips entries with malformed failover chain (no slash)", () => {
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(["badentry"], [], store);
      expect(store.size).toBe(0);
    });

    it("registers configured models even when absent from the failover chain", () => {
      // A session may select any configured model, not just failover-chain
      // entries; window lookups (status bar, session stats) must resolve for
      // those too.
      const store = createModelMetadataStore();
      initModelMetadataFromConfig(
        ["prov1/gpt-4o"],
        [
          {
            id: "provOther",
            models: { x: { contextWindowTokens: 999 } },
          },
        ],
        store,
      );

      expect(getModelContextWindowTokens("provOther", "x", store)).toBe(999);
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
        source: "config",
      });

      expect(getModelContextWindowTokens("anthropic", "claude-3", store)).toBe(200_000);
    });

    it("returns undefined for unknown models", () => {
      const store = createModelMetadataStore();
      expect(getModelContextWindowTokens("nonexistent", "model", store)).toBeUndefined();
    });

    it("returns undefined for unconfigured models even when other models of the same provider are known", () => {
      // No hard-coded defaults: a provider reporting one model's window must
      // not imply windows for its other models.
      const store = createModelMetadataStore();
      setModelMetadataFromProvider("prov1", "known-model", 200_000, store);

      expect(getModelContextWindowTokens("prov1", "unreported-model", store)).toBeUndefined();
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
