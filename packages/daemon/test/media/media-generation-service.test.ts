import { describe, it, vi, beforeEach, expect } from "vitest";
import {
  MediaGenerationService,
  type MediaAdapterRegistry,
} from "../../src/media/media-generation-service";
import type { MediaAdapterResult } from "../../src/media/adapters/types";
import type { MediaProviderConfig } from "../../src/media/resolve-model";
import type { ShoggothMediaGenerationConfig } from "@shoggoth/shared";

// -----------------------------------------------------------------------------
// DI: inject fake adapters via the constructor registry instead of mocking the
// adapter modules (vi.mock is import-order dependent under --no-isolate).
// -----------------------------------------------------------------------------

function completeImage(): MediaAdapterResult {
  return { status: "complete", path: "/tmp/media/output.png", mime_type: "image/png" };
}

function makeAdapters(overrides?: Partial<MediaAdapterRegistry>): MediaAdapterRegistry {
  return {
    "gemini-generate-content": vi.fn().mockResolvedValue(completeImage()),
    "gemini-predict": vi.fn().mockResolvedValue(completeImage()),
    "gemini-long-running": vi.fn().mockResolvedValue({
      status: "in_progress",
      operation_id: "operations/abc123",
    }),
    "openai-images": vi.fn().mockResolvedValue(completeImage()),
    "openai-chat-image": vi.fn().mockResolvedValue(completeImage()),
    "openai-video-async": vi.fn().mockResolvedValue({
      status: "complete",
      path: "/tmp/media/output.mp4",
      mime_type: "video/mp4",
    }),
    "openrouter-video": vi.fn().mockResolvedValue(completeImage()),
    ...overrides,
  };
}

function makeService(
  providers: MediaProviderConfig[],
  adapters: MediaAdapterRegistry = makeAdapters(),
  defaults?: ShoggothMediaGenerationConfig["defaults"],
): MediaGenerationService {
  return new MediaGenerationService({ providers, adapters, defaults });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("MediaGenerationService - Multi-Provider Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Routes to correct adapter based on provider.kind + model.mediaType", () => {
    it("openai-compatible + image → openai-chat-image", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "sk-test",
            models: [{ name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" }],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "black-forest-labs/flux.2-klein-4b",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(adapters["openai-chat-image"]).toHaveBeenCalledTimes(1);
      expect(adapters["openai-images"]).not.toHaveBeenCalled();
    });

    it("openai-compatible + video → openai-video-async", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "sk-test",
            models: [{ name: "google/veo-3.1", mediaType: "video" }],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "google/veo-3.1",
        prompt: "a sunset",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("complete");
      expect(adapters["openai-video-async"]).toHaveBeenCalledTimes(1);
    });

    it("gemini + image → gemini-generate-content", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            apiVersion: "v1beta",
            models: [{ name: "gemini-2.5-flash-image", mediaType: "image" }],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "gemini-2.5-flash-image",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(adapters["gemini-generate-content"]).toHaveBeenCalledTimes(1);
    });

    it("gemini + video → gemini-long-running", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            apiVersion: "v1beta",
            models: [{ name: "veo-3.1", mediaType: "video" }],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "veo-3.1",
        prompt: "a sunset timelapse",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("in_progress");
      expect(adapters["gemini-long-running"]).toHaveBeenCalledTimes(1);
    });
  });

  describe("Explicit adapter override on model", () => {
    it("uses openai-images when explicitly set despite openai-compatible + image default", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "openai-direct",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            models: [{ name: "dall-e-3", mediaType: "image", adapter: "openai-images" }],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "dall-e-3",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(adapters["openai-images"]).toHaveBeenCalledTimes(1);
      expect(adapters["openai-chat-image"]).not.toHaveBeenCalled();
    });

    it("uses gemini-predict when explicitly set on a gemini image model", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            models: [
              {
                name: "imagen-4.0-fast-generate-001",
                mediaType: "image",
                adapter: "gemini-predict",
              },
            ],
          },
        ],
        adapters,
      );

      const result = await service.generate({
        model: "imagen-4.0-fast-generate-001",
        prompt: "a landscape",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(adapters["gemini-predict"]).toHaveBeenCalledTimes(1);
      expect(adapters["gemini-generate-content"]).not.toHaveBeenCalled();
    });
  });

  describe("Error cases", () => {
    it("returns error for unknown model", async () => {
      const service = makeService([
        {
          id: "openrouter",
          kind: "openai-compatible",
          baseUrl: "https://openrouter.ai/api",
          apiKey: "sk-test",
          models: [{ name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" }],
        },
      ]);

      const result = await service.generate({
        model: "totally-unknown-model-xyz",
        prompt: "something",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("totally-unknown-model-xyz");
    });

    it("returns error when no providers configured", async () => {
      const service = makeService([]);

      const result = await service.generate({
        model: "any-model",
        prompt: "something",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
    });
  });

  describe("Provider info passed to adapter", () => {
    it("passes provider with id, kind, baseUrl, and apiKey to adapter", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "my-provider",
            kind: "openai-compatible",
            baseUrl: "https://custom.api.example.com",
            apiKey: "my-secret-key",
            models: [{ name: "test-model", mediaType: "image" }],
          },
        ],
        adapters,
      );

      await service.generate({
        model: "test-model",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(adapters["openai-chat-image"]).toHaveBeenCalledTimes(1);
      const adapterCall = (adapters["openai-chat-image"] as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(adapterCall.provider.id).toBe("my-provider");
      expect(adapterCall.provider.kind).toBe("openai-compatible");
      expect(adapterCall.provider.baseUrl).toBe("https://custom.api.example.com");
      expect(adapterCall.provider.apiKey).toBe("my-secret-key");
    });
  });

  describe("Multiple providers", () => {
    it("routes to correct provider based on model name", async () => {
      const adapters = makeAdapters();
      const service = makeService(
        [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "or-key",
            models: [
              { name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" },
              { name: "google/veo-3.1", mediaType: "video" },
            ],
          },
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            apiVersion: "v1beta",
            models: [
              { name: "gemini-2.5-flash-image", mediaType: "image" },
              { name: "veo-3.1", mediaType: "video" },
            ],
          },
        ],
        adapters,
      );

      // OpenRouter image
      await service.generate({
        model: "black-forest-labs/flux.2-klein-4b",
        prompt: "cat",
        params: { kind: "image" },
        output_path: "/tmp/out1.png",
      });

      // Google Gemini image
      await service.generate({
        model: "gemini-2.5-flash-image",
        prompt: "dog",
        params: { kind: "image" },
        output_path: "/tmp/out2.png",
      });

      expect(adapters["openai-chat-image"]).toHaveBeenCalledTimes(1);
      expect(adapters["gemini-generate-content"]).toHaveBeenCalledTimes(1);
    });
  });

  describe("Default model resolution (model omitted)", () => {
    const providers: MediaProviderConfig[] = [
      {
        id: "google",
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "g-key",
        models: [
          { name: "gemini-2.5-flash-image", mediaType: "image" },
          { name: "veo-3.1", mediaType: "video" },
          { name: "lyria-3-pro-preview", mediaType: "audio" },
          { name: "gemini-2.5-flash-preview-tts", mediaType: "audio" },
        ],
      },
    ];
    const allDefaults: ShoggothMediaGenerationConfig["defaults"] = {
      image: "google/gemini-2.5-flash-image",
      video: "google/veo-3.1",
      audio: "google/lyria-3-pro-preview",
      suggestions: {
        music: "google/lyria-3-pro-preview",
        tts: "google/gemini-2.5-flash-preview-tts",
      },
    };

    it("uses the configured default for the request's media kind", async () => {
      const adapters = makeAdapters();
      const service = makeService(providers, adapters, allDefaults);

      const result = await service.generate({
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      const call = (adapters["gemini-generate-content"] as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.model).toBe("gemini-2.5-flash-image");
    });

    it("prefers the audio default over suggestions for speech", async () => {
      const adapters = makeAdapters();
      const service = makeService(providers, adapters, allDefaults);

      await service.generate({
        prompt: "hello",
        params: { kind: "speech" },
        output_path: "/tmp/out.wav",
      });

      const call = (adapters["gemini-generate-content"] as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.model).toBe("lyria-3-pro-preview");
    });

    it("does not auto-apply suggestions when no generic default is configured", async () => {
      const service = makeService(providers, makeAdapters(), {
        image: "google/gemini-2.5-flash-image",
        suggestions: { tts: "google/gemini-2.5-flash-preview-tts" },
      });

      const result = await service.generate({
        prompt: "hello",
        params: { kind: "speech" },
        output_path: "/tmp/out.wav",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("no default model configured");
    });

    it("applies the audio default for music requests when configured", async () => {
      const adapters = makeAdapters();
      const service = makeService(providers, adapters, {
        image: "google/gemini-2.5-flash-image",
        audio: "google/lyria-3-pro-preview",
        suggestions: { music: "google/gemini-2.5-flash-preview-tts" },
      });

      await service.generate({
        prompt: "a happy tune",
        params: { kind: "music" },
        output_path: "/tmp/out.wav",
      });

      const call = (adapters["gemini-generate-content"] as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.model).toBe("lyria-3-pro-preview");
    });

    it("uses the video default for video requests", async () => {
      const adapters = makeAdapters();
      const service = makeService(providers, adapters, allDefaults);

      await service.generate({
        prompt: "a rocket launch",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(adapters["gemini-long-running"]).toHaveBeenCalledTimes(1);
    });

    it("explicit model wins over the configured default", async () => {
      const adapters = makeAdapters();
      const service = makeService(providers, adapters, allDefaults);

      await service.generate({
        model: "veo-3.1",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      const call = (adapters["gemini-long-running"] as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.model).toBe("veo-3.1");
    });

    it("returns error when no model and no default are configured", async () => {
      const service = makeService(providers, makeAdapters(), {});

      const result = await service.generate({
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("no default model configured");
    });

    it("returns error when defaults block is absent entirely", async () => {
      const service = makeService(providers, makeAdapters());

      const result = await service.generate({
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("no default model configured");
    });

    it("fromConfig passes defaults through to generate", async () => {
      const adapters = makeAdapters();
      const service = MediaGenerationService.fromConfig(
        {
          defaults: allDefaults,
          providers: {
            google: {
              kind: "gemini",
              apiKey: "g-key",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: {
                "gemini-2.5-flash-image": { mediaType: "image" },
                "veo-3.1": { mediaType: "video" },
                "lyria-3-pro-preview": { mediaType: "audio" },
                "gemini-2.5-flash-preview-tts": { mediaType: "audio" },
              },
            },
          },
        },
        adapters,
      );

      const result = await service.generate({
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      const call = (adapters["gemini-generate-content"] as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.model).toBe("gemini-2.5-flash-image");
    });
  });

  describe("Unknown adapter name", () => {
    it("returns error when adapter name is not in the registry", async () => {
      const service = makeService(
        [
          {
            id: "x",
            kind: "openai-compatible",
            baseUrl: "https://api.example.com",
            apiKey: "k",
            models: [{ name: "m", mediaType: "image", adapter: "not-a-real-adapter" }],
          },
        ],
        makeAdapters(),
      );

      const result = await service.generate({
        model: "m",
        prompt: "hi",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("Unknown adapter");
    });
  });
});
