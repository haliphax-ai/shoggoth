import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveMemoryEmbeddingApiKey,
  resolveMemoryEmbeddingApiKeyEnv,
} from "../../src/memory/memory-embeddings-resolve";
import type { ShoggothMemoryConfig } from "@shoggoth/shared";

function memCfg(overrides: Partial<ShoggothMemoryConfig["embeddings"]> = {}): ShoggothMemoryConfig {
  return {
    paths: ["/tmp/memory"],
    embeddings: { enabled: true, ...overrides },
  } as ShoggothMemoryConfig;
}

describe("resolveMemoryEmbeddingApiKey", () => {
  it("returns bare apiKey when set", () => {
    const key = resolveMemoryEmbeddingApiKey(memCfg({ apiKey: "bare-key" }), {});
    assert.equal(key, "bare-key");
  });

  it("falls back to apiKeyEnv from env", () => {
    const key = resolveMemoryEmbeddingApiKey(memCfg({ apiKeyEnv: "MY_KEY" }), { MY_KEY: "env-val" });
    assert.equal(key, "env-val");
  });

  it("bare apiKey takes precedence over apiKeyEnv", () => {
    const key = resolveMemoryEmbeddingApiKey(
      memCfg({ apiKey: "bare", apiKeyEnv: "MY_KEY" }),
      { MY_KEY: "env-val" },
    );
    assert.equal(key, "bare");
  });

  it("falls back to OPENAI_API_KEY when neither apiKey nor apiKeyEnv set", () => {
    const key = resolveMemoryEmbeddingApiKey(memCfg(), { OPENAI_API_KEY: "default-key" });
    assert.equal(key, "default-key");
  });

  it("returns undefined when no key available", () => {
    const key = resolveMemoryEmbeddingApiKey(memCfg(), {});
    assert.equal(key, undefined);
  });
});

describe("resolveMemoryEmbeddingApiKeyEnv", () => {
  it("returns configured env var name", () => {
    assert.equal(resolveMemoryEmbeddingApiKeyEnv(memCfg({ apiKeyEnv: "CUSTOM" })), "CUSTOM");
  });

  it("defaults to OPENAI_API_KEY", () => {
    assert.equal(resolveMemoryEmbeddingApiKeyEnv(memCfg()), "OPENAI_API_KEY");
  });
});
