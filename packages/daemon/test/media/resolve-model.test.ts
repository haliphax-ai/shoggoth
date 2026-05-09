import { describe, it, expect, vi } from "vitest";
import {
  resolveModel,
  resolveMediaProvider,
  type MediaProviderConfig,
} from "../../src/media/resolve-model";

describe("resolveModel", () => {
  const mockProviders: MediaProviderConfig[] = [
    {
      id: "openrouter",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api",
      apiKey: "sk-test-openrouter",
      models: [
        { name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" },
        { name: "openai/gpt-5-image", mediaType: "image" },
        { name: "google/veo-3.1", mediaType: "video" },
        { name: "recraft/recraft-v4", mediaType: "image", adapter: "openai-images" },
      ],
    },
    {
      id: "google",
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-google-key",
      apiVersion: "v1beta",
      models: [
        { name: "gemini-2.5-flash-image", mediaType: "image" },
        { name: "veo-3.1", mediaType: "video" },
      ],
    },
  ];

  it("resolves openai-compatible image model to openai-chat-image adapter", () => {
    const result = resolveModel("black-forest-labs/flux.2-klein-4b", mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("openrouter");
    expect(result?.adapter).toBe("openai-chat-image");
  });

  it("resolves openai-compatible video model to openai-video-async adapter", () => {
    const result = resolveModel("google/veo-3.1", mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("openrouter");
    expect(result?.adapter).toBe("openai-video-async");
  });

  it("resolves gemini image model to gemini-generate-content adapter", () => {
    const result = resolveModel("gemini-2.5-flash-image", mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("google");
    expect(result?.adapter).toBe("gemini-generate-content");
  });

  it("resolves gemini video model to gemini-long-running adapter", () => {
    const result = resolveModel("veo-3.1", mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("google");
    expect(result?.adapter).toBe("gemini-long-running");
  });

  it("uses explicit adapter override when specified on model", () => {
    const result = resolveModel("recraft/recraft-v4", mockProviders);
    expect(result).toBeDefined();
    expect(result?.provider.id).toBe("openrouter");
    expect(result?.adapter).toBe("openai-images");
  });

  it("returns undefined for unknown model", () => {
    const result = resolveModel("unknown-model-xyz", mockProviders);
    expect(result).toBeUndefined();
  });

  it("first provider match wins when model name appears in multiple providers", () => {
    const providers: MediaProviderConfig[] = [
      {
        id: "first",
        kind: "openai-compatible",
        baseUrl: "https://first.example.com",
        apiKey: "key1",
        models: [{ name: "shared-model", mediaType: "image" }],
      },
      {
        id: "second",
        kind: "gemini",
        baseUrl: "https://second.example.com",
        apiKey: "key2",
        models: [{ name: "shared-model", mediaType: "image" }],
      },
    ];
    const result = resolveModel("shared-model", providers);
    expect(result?.provider.id).toBe("first");
    expect(result?.adapter).toBe("openai-chat-image");
  });

  it("returns undefined when mediaType has no default adapter for the provider kind", () => {
    const providers: MediaProviderConfig[] = [
      {
        id: "test",
        kind: "openai-compatible",
        baseUrl: "https://test.example.com",
        apiKey: "key",
        models: [{ name: "audio-model", mediaType: "audio" }],
      },
    ];
    const result = resolveModel("audio-model", providers);
    expect(result).toBeUndefined();
  });
});

describe("resolveMediaProvider", () => {
  it("extracts apiKey from field", () => {
    const config = { apiKey: "direct-key-123" };
    const result = resolveMediaProvider(config);
    expect(result).toBe("direct-key-123");
  });

  it("extracts apiKey from env var (apiKeyEnv)", () => {
    vi.stubEnv("MY_API_KEY", "env-key-456");
    const config = { apiKeyEnv: "MY_API_KEY" };
    const result = resolveMediaProvider(config);
    expect(result).toBe("env-key-456");
    vi.unstubAllEnvs();
  });
});
