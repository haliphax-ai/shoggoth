import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// Mock the adapters
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

import { generateContentAdapter } from "../../src/media/adapters/generate-content-adapter";
import { predictAdapter } from "../../src/media/adapters/predict-adapter";
import { longRunningAdapter } from "../../src/media/adapters/long-running-adapter";
import { MediaGenerationService } from "../../src/media/media-generation-service";
import type { MediaAdapterResult } from "../../src/media/adapters/types";

function makeProviders(overrides?: { kind?: string; id?: string }[]) {
  const defaults = [
    {
      id: "gemini-default",
      kind: "gemini" as const,
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [{ name: "nano-banana" }],
    },
  ];
  if (overrides) {
    return overrides.map((o) => ({
      id: o.id ?? "gemini-default",
      kind: o.kind ?? "gemini",
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [{ name: "nano-banana" }],
    }));
  }
  return defaults;
}

interface ServiceConfig {
  providers: Array<{
    id: string;
    kind: string;
    apiKey?: string;
    baseUrl?: string;
    models?: Array<{ name: string }>;
  }>;
  modelAdapterMap?: Record<string, "generateContent" | "predict" | "longRunning">;
}

function createService(configOverrides?: Partial<ServiceConfig>) {
  const config: ServiceConfig = {
    providers: makeProviders(),
    ...configOverrides,
  };
  return new MediaGenerationService(config);
}

describe("MediaGenerationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("model routing", () => {
    it("routes to generateContent adapter for nano-banana models", async () => {
      const service = createService();

      await service.generate({
        model: "nano-banana",
        prompt: "a cat",
        provider_id: "gemini-default",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 1);
      assert.strictEqual(vi.mocked(predictAdapter).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(longRunningAdapter).mock.calls.length, 0);
    });

    it("routes to predict adapter for imagen models", async () => {
      const service = createService();

      await service.generate({
        model: "imagen-4.0-generate-preview-06-2025",
        prompt: "a landscape",
        provider_id: "gemini-default",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      assert.strictEqual(vi.mocked(predictAdapter).mock.calls.length, 1);
      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(longRunningAdapter).mock.calls.length, 0);
    });

    it("routes to longRunning adapter for veo models", async () => {
      const service = createService();

      await service.generate({
        model: "veo-3.1-generate-preview",
        prompt: "a sunset timelapse",
        provider_id: "gemini-default",
        params: { kind: "video" },
        output_path: "/tmp/out.mp4",
      });

      assert.strictEqual(vi.mocked(longRunningAdapter).mock.calls.length, 1);
      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(predictAdapter).mock.calls.length, 0);
    });
  });

  describe("operator modelAdapterMap override", () => {
    it("merges operator modelAdapterMap on top of built-in defaults", async () => {
      const service = createService({
        modelAdapterMap: {
          "my-custom-model": "generateContent",
        },
      });

      await service.generate({
        model: "my-custom-model",
        prompt: "custom prompt",
        provider_id: "gemini-default",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      // Custom model should route to generateContent via operator override
      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 1);
    });
  });

  describe("error handling", () => {
    it("returns error for unknown model names", async () => {
      const service = createService();

      const result = await service.generate({
        model: "totally-unknown-model-xyz",
        prompt: "something",
        provider_id: "gemini-default",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      assert.strictEqual(result.status, "error");
      assert.ok(
        (result as MediaAdapterResult & { status: "error" }).error.includes(
          "totally-unknown-model-xyz",
        ),
      );
      // No adapter should have been called
      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(predictAdapter).mock.calls.length, 0);
      assert.strictEqual(vi.mocked(longRunningAdapter).mock.calls.length, 0);
    });
  });

  describe("provider resolution", () => {
    it("resolves provider config by provider_id", async () => {
      const service = createService({
        providers: [
          {
            id: "my-gemini",
            kind: "gemini",
            apiKey: "my-key",
            baseUrl: "https://custom.api.example.com",
            models: [],
          },
          {
            id: "other-provider",
            kind: "gemini",
            apiKey: "other-key",
            baseUrl: "https://other.api.example.com",
            models: [],
          },
        ],
      });

      await service.generate({
        model: "nano-banana",
        prompt: "a dog",
        provider_id: "my-gemini",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 1);
      const adapterReq = vi.mocked(generateContentAdapter).mock.calls[0][0];
      assert.strictEqual(adapterReq.apiKey, "my-key");
      assert.strictEqual(adapterReq.baseUrl, "https://custom.api.example.com");
    });

    it("returns error when provider is not kind: 'gemini'", async () => {
      const service = createService({
        providers: [
          {
            id: "openai-provider",
            kind: "openai-compatible",
            apiKey: "oai-key",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        ],
      });

      const result = await service.generate({
        model: "nano-banana",
        prompt: "a cat",
        provider_id: "openai-provider",
        params: { kind: "image" },
        output_path: "/tmp/out.png",
      });

      assert.strictEqual(result.status, "error");
      assert.ok((result as MediaAdapterResult & { status: "error" }).error.includes("gemini"));
      // No adapter should have been called
      assert.strictEqual(vi.mocked(generateContentAdapter).mock.calls.length, 0);
    });
  });
});
