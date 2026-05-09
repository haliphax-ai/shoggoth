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
import type { ResolvedMediaProvider } from "../../src/media/resolve-model";

// -----------------------------------------------------------------------------
// Types for new config shape
// -----------------------------------------------------------------------------

interface ModelEntry {
  pattern: string;
  provider: string;
  adapter:
    | "openai-images"
    | "openai-chat-image"
    | "openai-video-async"
    | "gemini-generate-content"
    | "gemini-predict"
    | "gemini-long-running";
}

interface NewServiceConfig {
  providers: Array<{
    id: string;
    kind: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
  models: ModelEntry[];
}

function createService(config: NewServiceConfig): MediaGenerationService {
  return new MediaGenerationService(config as unknown as Parameters<typeof MediaGenerationService>[0]);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("MediaGenerationService - Multi-Provider Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Routes to openai-images adapter when model matches pattern", () => {
    it("routes dall-e-3 to openai-images adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        models: [{ pattern: "dall-e-*", provider: "openai", adapter: "openai-images" }],
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
      expect(openaiVideoAsyncAdapter).not.toHaveBeenCalled();
      expect(generateContentAdapter).not.toHaveBeenCalled();
      expect(predictAdapter).not.toHaveBeenCalled();
      expect(longRunningAdapter).not.toHaveBeenCalled();
    });

    it("routes black-forest-labs/flux-schnell to openai-images adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "local",
            kind: "openai-compatible",
            apiKey: "local-key",
            baseUrl: "http://localhost:11434/v1",
          },
        ],
        models: [{ pattern: "black-forest-labs/*", provider: "local", adapter: "openai-images" }],
      });

      const result = await service.generate({
        model: "black-forest-labs/flux-schnell",
        prompt: "a landscape",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(openAIImagesAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. Routes to openai-chat-image adapter", () => {
    it("routes gpt-image-1 to openai-chat-image adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        models: [{ pattern: "gpt-image-*", provider: "openai", adapter: "openai-chat-image" }],
      });

      const result = await service.generate({
        model: "gpt-image-1",
        prompt: "a dog",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(openAIChatImageAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. Routes to openai-video-async adapter", () => {
    it("routes sve-*-video to openai-video-async adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        models: [{ pattern: "sve-*-video", provider: "openai", adapter: "openai-video-async" }],
      });

      const result = await service.generate({
        model: "sve-1-0-video",
        prompt: "a sunset timelapse",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("complete");
      expect(openaiVideoAsyncAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("4. Routes to gemini-generate-content adapter", () => {
    it("routes gemini-*-image to gemini-generate-content adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        ],
        models: [
          { pattern: "gemini-*-image", provider: "google", adapter: "gemini-generate-content" },
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
  });

  describe("5. Routes to gemini-predict adapter", () => {
    it("routes imagen-* to gemini-predict adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        ],
        models: [{ pattern: "imagen-*", provider: "google", adapter: "gemini-predict" }],
      });

      const result = await service.generate({
        model: "imagen-4.0-generate-preview-06-2025",
        prompt: "a landscape",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("complete");
      expect(predictAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("6. Routes to gemini-long-running adapter", () => {
    it("routes veo-* to gemini-long-running adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "google",
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        ],
        models: [{ pattern: "veo-*", provider: "google", adapter: "gemini-long-running" }],
      });

      const result = await service.generate({
        model: "veo-3.1-generate-preview",
        prompt: "a sunset timelapse",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      expect(result.status).toBe("in_progress");
      expect(longRunningAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe("7. Returns error when model doesn't match any pattern", () => {
    it("returns error for unknown model names", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        models: [{ pattern: "dall-e-*", provider: "openai", adapter: "openai-images" }],
      });

      const result = await service.generate({
        model: "totally-unknown-model-xyz",
        prompt: "something",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("totally-unknown-model-xyz");
      // No adapter should have been called
      expect(openAIImagesAdapter).not.toHaveBeenCalled();
      expect(openAIChatImageAdapter).not.toHaveBeenCalled();
      expect(openaiVideoAsyncAdapter).not.toHaveBeenCalled();
      expect(generateContentAdapter).not.toHaveBeenCalled();
      expect(predictAdapter).not.toHaveBeenCalled();
      expect(longRunningAdapter).not.toHaveBeenCalled();
    });

    it("returns error when models array is empty", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
        models: [],
      });

      const result = await service.generate({
        model: "any-model",
        prompt: "something",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("any-model");
    });
  });

  describe("8. Passes ResolvedMediaProvider in adapter request", () => {
    it("passes provider with id, kind, baseUrl, and apiKey to adapter", async () => {
      const service = createService({
        providers: [
          {
            id: "my-openai",
            kind: "openai-compatible",
            apiKey: "my-secret-key",
            baseUrl: "https://custom.api.example.com/v1",
          },
        ],
        models: [{ pattern: "dall-e-*", provider: "my-openai", adapter: "openai-images" }],
      });

      await service.generate({
        model: "dall-e-3",
        prompt: "a cat",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(openAIImagesAdapter).toHaveBeenCalledTimes(1);
      const adapterCall = (openAIImagesAdapter as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // The new implementation should pass a ResolvedMediaProvider object
      expect(adapterCall).toHaveProperty("provider");
      const provider = (adapterCall as { provider: ResolvedMediaProvider }).provider;
      expect(provider.id).toBe("my-openai");
      expect(provider.kind).toBe("openai-compatible");
      expect(provider.baseUrl).toBe("https://custom.api.example.com/v1");
      expect(provider.apiKey).toBe("my-secret-key");
    });

    it("resolves provider for gemini-generate-content", async () => {
      const service = createService({
        providers: [
          {
            id: "google-gemini",
            kind: "gemini",
            apiKey: "gemini-key-123",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        ],
        models: [
          { pattern: "gemini-*-image", provider: "google-gemini", adapter: "gemini-generate-content" },
        ],
      });

      await service.generate({
        model: "gemini-2.0-flash-image",
        prompt: "test prompt",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(generateContentAdapter).toHaveBeenCalledTimes(1);
      const adapterCall = (generateContentAdapter as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // The new implementation should pass provider info in the request
      expect(adapterCall).toHaveProperty("provider");
    });

    it("returns error when provider not found for matched model", async () => {
      const service = createService({
        providers: [
          {
            id: "existing-provider",
            kind: "openai-compatible",
            apiKey: "key",
            baseUrl: "https://api.example.com",
          },
        ],
        models: [{ pattern: "some-model", provider: "nonexistent-provider", adapter: "openai-images" }],
      });

      const result = await service.generate({
        model: "some-model",
        prompt: "test",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      expect(result.status).toBe("error");
      expect((result as { error: string }).error).toContain("nonexistent-provider");
    });
  });

  describe("Multiple providers and models", () => {
    it("routes to correct provider based on model pattern", async () => {
      const service = createService({
        providers: [
          {
            id: "openai",
            kind: "openai-compatible",
            apiKey: "openai-key",
            baseUrl: "https://api.openai.com/v1",
          },
          {
            id: "google",
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
          },
        ],
        models: [
          { pattern: "dall-e-*", provider: "openai", adapter: "openai-images" },
          { pattern: "gemini-*", provider: "google", adapter: "gemini-generate-content" },
        ],
      });

      // Test OpenAI route
      await service.generate({
        model: "dall-e-3",
        prompt: "cat",
        params: { kind: "image" },
        output_path: "/tmp/out1.png",
      });

      // Test Gemini route
      await service.generate({
        model: "gemini-2.0-flash",
        prompt: "dog",
        params: { kind: "image" },
        output_path: "/tmp/out2.png",
      });

      expect(openAIImagesAdapter).toHaveBeenCalledTimes(1);
      expect(generateContentAdapter).toHaveBeenCalledTimes(1);
    });

    it("first matching pattern wins when patterns overlap", async () => {
      const service = createService({
        providers: [
          {
            id: "local",
            kind: "openai-compatible",
            apiKey: "local-key",
            baseUrl: "http://localhost:11434/v1",
          },
        ],
        models: [
          { pattern: "gemini-*", provider: "local", adapter: "openai-images" },
          { pattern: "gemini-2.0-*", provider: "local", adapter: "openai-chat-image" },
        ],
      });

      await service.generate({
        model: "gemini-2.0-flash",
        prompt: "test",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      // First pattern wins
      expect(openAIImagesAdapter).toHaveBeenCalledTimes(1);
      expect(openAIChatImageAdapter).not.toHaveBeenCalled();
    });
  });
});