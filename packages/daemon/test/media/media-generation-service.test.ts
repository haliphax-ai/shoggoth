import { describe, it, vi, beforeEach, expect } from "vitest";

// Mock all adapters
vi.mock("../../src/media/adapters/openai-images-adapter", () => ({
  openAIImagesAdapter: vi.fn().mockResolvedValue({
    status: "complete",
    path: "/tmp/media/output.png",
    mime_type: "image/png",
  }),
}));

vi.mock("../../src/media/adapters/openai-chat-image-adapter", () => ({
  openAIChatImageAdapter: vi.fn().mockResolvedValue({
    status: "complete",
    path: "/tmp/media/output.png",
    mime_type: "image/png",
  }),
}));

vi.mock("../../src/media/adapters/openai-video-async-adapter", () => ({
  openaiVideoAsyncAdapter: vi.fn().mockResolvedValue({
    status: "complete",
    path: "/tmp/media/output.mp4",
    mime_type: "video/mp4",
  }),
}));

vi.mock("../../src/media/adapters/generate-content-adapter", () => ({
  generateContentAdapter: vi.fn().mockResolvedValue({
    status: "complete",
    path: "/tmp/media/output.png",
    mime_type: "image/png",
  }),
}));

vi.mock("../../src/media/adapters/predict-adapter", () => ({
  predictAdapter: vi.fn().mockResolvedValue({
    status: "complete",
    path: "/tmp/media/output.png",
    mime_type: "image/png",
  }),
}));

vi.mock("../../src/media/adapters/long-running-adapter", () => ({
  longRunningAdapter: vi.fn().mockResolvedValue({
    status: "in_progress",
    operation_id: "operations/abc123",
  }),
}));

import { openAIImagesAdapter } from "../../src/media/adapters/openai-images-adapter";
import { openAIChatImageAdapter } from "../../src/media/adapters/openai-chat-image-adapter";
import { openaiVideoAsyncAdapter } from "../../src/media/adapters/openai-video-async-adapter";
import { generateContentAdapter } from "../../src/media/adapters/generate-content-adapter";
import { predictAdapter } from "../../src/media/adapters/predict-adapter";
import { longRunningAdapter } from "../../src/media/adapters/long-running-adapter";
import { MediaGenerationService } from "../../src/media/media-generation-service";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("MediaGenerationService - Multi-Provider Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Routes to correct adapter based on provider.kind + model.mediaType", () => {
    it("openai-compatible + image → openai-chat-image", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "sk-test",
            models: [{ name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" }],
          },
        ],
      });

      const result = await service.generate({
        model: "black-forest-labs/flux.2-klein-4b",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(openAIChatImageAdapter).toHaveBeenCalledTimes(1);
      expect(openAIImagesAdapter).not.toHaveBeenCalled();
    });

    it("openai-compatible + video → openai-video-async", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "sk-test",
            models: [{ name: "google/veo-3.1", mediaType: "video" }],
          },
        ],
      });

      const result = await service.generate({
        model: "google/veo-3.1",
        prompt: "a sunset",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("complete");
      expect(openaiVideoAsyncAdapter).toHaveBeenCalledTimes(1);
    });

    it("gemini + image → gemini-generate-content", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            apiVersion: "v1beta",
            models: [{ name: "gemini-2.5-flash-image", mediaType: "image" }],
          },
        ],
      });

      const result = await service.generate({
        model: "gemini-2.5-flash-image",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(generateContentAdapter).toHaveBeenCalledTimes(1);
    });

    it("gemini + video → gemini-long-running", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            apiVersion: "v1beta",
            models: [{ name: "veo-3.1", mediaType: "video" }],
          },
        ],
      });

      const result = await service.generate({
        model: "veo-3.1",
        prompt: "a sunset timelapse",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("in_progress");
      expect(longRunningAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("Explicit adapter override on model", () => {
    it("uses openai-images when explicitly set despite openai-compatible + image default", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "openai-direct",
            kind: "openai-compatible",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            models: [{ name: "dall-e-3", mediaType: "image", adapter: "openai-images" }],
          },
        ],
      });

      const result = await service.generate({
        model: "dall-e-3",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(openAIImagesAdapter).toHaveBeenCalledTimes(1);
      expect(openAIChatImageAdapter).not.toHaveBeenCalled();
    });

    it("uses gemini-predict when explicitly set on a gemini image model", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "google-key",
            models: [
              {
                name: "imagen-4.0-generate-preview",
                mediaType: "image",
                adapter: "gemini-predict",
              },
            ],
          },
        ],
      });

      const result = await service.generate({
        model: "imagen-4.0-generate-preview",
        prompt: "a landscape",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(predictAdapter).toHaveBeenCalledTimes(1);
      expect(generateContentAdapter).not.toHaveBeenCalled();
    });
  });

  describe("Error cases", () => {
    it("returns error for unknown model", async () => {
      const service = new MediaGenerationService({
        providers: [
          {
            id: "openrouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api",
            apiKey: "sk-test",
            models: [{ name: "black-forest-labs/flux.2-klein-4b", mediaType: "image" }],
          },
        ],
      });

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
      const service = new MediaGenerationService({ providers: [] });

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
      const service = new MediaGenerationService({
        providers: [
          {
            id: "my-provider",
            kind: "openai-compatible",
            baseUrl: "https://custom.api.example.com",
            apiKey: "my-secret-key",
            models: [{ name: "test-model", mediaType: "image" }],
          },
        ],
      });

      await service.generate({
        model: "test-model",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(openAIChatImageAdapter).toHaveBeenCalledTimes(1);
      const adapterCall = (openAIChatImageAdapter as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(adapterCall.provider.id).toBe("my-provider");
      expect(adapterCall.provider.kind).toBe("openai-compatible");
      expect(adapterCall.provider.baseUrl).toBe("https://custom.api.example.com");
      expect(adapterCall.provider.apiKey).toBe("my-secret-key");
    });
  });

  describe("Multiple providers", () => {
    it("routes to correct provider based on model name", async () => {
      const service = new MediaGenerationService({
        providers: [
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
      });

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

      expect(openAIChatImageAdapter).toHaveBeenCalledTimes(1);
      expect(generateContentAdapter).toHaveBeenCalledTimes(1);
    });
  });
});
