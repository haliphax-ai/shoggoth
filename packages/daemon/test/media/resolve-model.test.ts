import { describe, it, expect, vi } from "vitest";
import {
  resolveModel,
  resolveMediaProvider,
  type MediaGenerationModelEntry,
  type ResolvedMediaProvider,
} from "../../src/media/resolve-model";

describe("resolveModel", () => {
  const mockProviders: ResolvedMediaProvider[] = [
    {
      id: "openai",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-openai",
    },
    {
      id: "google",
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-google-key",
      apiVersion: "v1",
    },
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "test-local-key",
    },
  ];

  const mockModels: MediaGenerationModelEntry[] = [
    { pattern: "dall-e-*", provider: "openai", adapter: "openai-images" },
    { pattern: "black-forest-labs/*", provider: "local", adapter: "flux" },
    { pattern: "gemini-*-image", provider: "google", adapter: "gemini-image" },
    { pattern: "gemini-2.0-flash-exp", provider: "google", adapter: "gemini-chat" },
  ];

  it("1. Exact match returns correct provider+adapter", () => {
    const result = resolveModel("dall-e-3", mockModels, mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("openai");
    expect(result?.adapter).toBe("openai-images");
  });

  it("2. Glob with trailing wildcard matches", () => {
    const result = resolveModel("black-forest-labs/flux-schnell", mockModels, mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("local");
    expect(result?.adapter).toBe("flux");
  });

  it("3. Glob with middle wildcard matches", () => {
    const result = resolveModel("gemini-1.5-pro-image", mockModels, mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("google");
    expect(result?.adapter).toBe("gemini-image");
  });

  it("4. First-match-wins ordering", () => {
    const modelsWithOverlap: MediaGenerationModelEntry[] = [
      { pattern: "gemini-*", provider: "local", adapter: "local-gemini" },
      { pattern: "gemini-2.0-flash-exp", provider: "google", adapter: "gemini-chat" },
    ];

    const result = resolveModel("gemini-2.0-flash-exp", modelsWithOverlap, mockProviders);
    expect(result).toBeDefined();
    // First pattern wins, should match "local" provider even though "google" also matches
    expect(result?.provider.id).toBe("local");
    expect(result?.adapter).toBe("local-gemini");
  });

  it("5. No match returns undefined", () => {
    const result = resolveModel("unknown-model-xyz", mockModels, mockProviders);
    expect(result).toBeUndefined();
  });

  it("6. Provider not found returns undefined", () => {
    const modelsWithUnknownProvider: MediaGenerationModelEntry[] = [
      { pattern: "some-model", provider: "nonexistent-provider", adapter: "some-adapter" },
    ];
    const result = resolveModel("some-model", modelsWithUnknownProvider, mockProviders);
    expect(result).toBeUndefined();
  });
});

describe("resolveMediaProvider", () => {
  it("7. extracts apiKey from field", () => {
    const config = { apiKey: "direct-key-123" };
    const result = resolveMediaProvider(config);
    expect(result).toBe("direct-key-123");
  });

  it("8. extracts apiKey from env var (apiKeyEnv)", () => {
    vi.stubEnv("MY_API_KEY", "env-key-456");
    const config = { apiKeyEnv: "MY_API_KEY" };
    const result = resolveMediaProvider(config);
    expect(result).toBe("env-key-456");
    vi.unstubAllEnvs();
  });
});