import { describe, it, vi, beforeEach, expect } from "vitest";

// Mock the media generation service to avoid circular deps
vi.mock("../../src/media/media-generation-service", () => ({
  MediaGenerationService: vi.fn().mockImplementation(() => ({
    generate: vi
      .fn()
      .mockResolvedValue({ status: "complete", path: "/tmp/out.png", mime_type: "image/png" }),
  })),
}));

// Mock config to test the finalizer
const mockConfig = vi.fn();

vi.mock("../../src/config-hot-reload", () => ({
  getConfig: mockConfig,
}));

import { createMediaGenerateToolFinalizer } from "../../src/sessions/session-mcp-tool-context";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import type { ShoggothConfig } from "@shoggoth/shared";

function makeConfig(
  overrides?: Partial<{ mediaGeneration: ShoggothConfig["mediaGeneration"] }>,
): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    operatorDirectory: "/tmp/operator",
    configDirectory: "/tmp/config",
    hitl: {
      defaultApprovalTimeoutMs: 300000,
      toolRisk: { read: "safe", write: "caution" },
      bypassUpTo: "safe",
    },
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: {
      operator: {
        controlOps: { allow: ["*"], deny: [], review: [] },
        tools: { allow: ["*"], deny: [], review: [] },
      },
      agent: {
        controlOps: { allow: ["*"], deny: [], review: [] },
        tools: { allow: ["*"], deny: [], review: [] },
      },
      auditRedaction: { jsonPaths: [] },
    },
    models: { providers: {} },
    mediaGeneration: { providers: {} },
    ...overrides,
  } as ShoggothConfig;
}

// ---------------------------------------------------------------------------
// Tests for media-generate tool finalizer based on new config shape
// ---------------------------------------------------------------------------

describe("createMediaGenerateToolFinalizer - Multi-Provider Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Tool injected when providers have models", () => {
    it("injects builtin-media-generate when a provider has models", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            openrouter: {
              kind: "openai-compatible",
              baseUrl: "https://openrouter.ai/api",
              models: { "black-forest-labs/flux.2-klein-4b": { mediaType: "image" } },
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });

    it("injects tool when gemini provider has models", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            google: {
              kind: "gemini",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: {
                "gemini-2.5-flash-image": { mediaType: "image" },
                "veo-3.1": { mediaType: "video" },
              },
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });
  });

  describe("2. Tool NOT injected when config absent or no models", () => {
    it("does not inject tool when mediaGeneration is undefined", () => {
      const config = makeConfig({
        mediaGeneration: undefined as unknown as ShoggothConfig["mediaGeneration"],
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(false);
    });

    it("does not inject tool when providers array is empty", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {},
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(false);
    });

    it("does not inject tool when providers exist but have no models", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            openrouter: {
              kind: "openai-compatible",
              baseUrl: "https://openrouter.ai/api",
              models: {},
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(false);
    });

    it("does not inject tool when mediaGeneration is empty object", () => {
      const config = makeConfig({
        mediaGeneration: {} as ShoggothConfig["mediaGeneration"],
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(false);
    });
  });

  describe("3. Default models in descriptor", () => {
    function descriptor(config: ShoggothConfig) {
      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");
      return result.aggregated.tools.find((t) => t.namespacedName === "builtin-media-generate");
    }

    const providers = {
      google: {
        kind: "gemini" as const,
        baseUrl: "https://generativelanguage.googleapis.com",
        models: {
          "gemini-2.5-flash-image": { mediaType: "image" as const },
          "veo-3.1": { mediaType: "video" as const },
          "lyria-3-pro-preview": { mediaType: "audio" as const },
        },
      },
    };

    it("makes model optional and lists defaults when all types configured", () => {
      const config = makeConfig({
        mediaGeneration: {
          defaults: {
            image: "google/gemini-2.5-flash-image",
            video: "google/veo-3.1",
            audio: "google/lyria-3-pro-preview",
            suggestions: { music: "google/lyria-3-pro-preview" },
          },
          providers,
        },
      });

      const tool = descriptor(config);
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as {
        required: string[];
        properties: Record<string, { description: string }>;
      };
      expect(schema.required).not.toContain("model");
      expect(schema.properties.model!.description).toContain("google/gemini-2.5-flash-image");
      expect(schema.properties.model!.description).toContain("google/veo-3.1");
      expect(schema.properties.model!.description).toContain("google/lyria-3-pro-preview");
      // suggestions exposed alongside defaults as hints
      expect(tool!.description).toContain("music 'google/lyria-3-pro-preview'");
    });

    it("keeps model required when defaults are not configured", () => {
      const config = makeConfig({
        mediaGeneration: { providers },
      });

      const tool = descriptor(config);
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as { required: string[] };
      expect(schema.required).toContain("model");
    });

    it("keeps model required when only some defaults are configured", () => {
      const config = makeConfig({
        mediaGeneration: {
          defaults: { image: "google/gemini-2.5-flash-image" },
          providers,
        },
      });

      const tool = descriptor(config);
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as { required: string[] };
      expect(schema.required).toContain("model");
    });

    it("lists suggestions in the model description too", () => {
      const config = makeConfig({
        mediaGeneration: {
          defaults: {
            image: "google/gemini-2.5-flash-image",
            video: "google/veo-3.1",
            audio: "google/lyria-3-pro-preview",
            suggestions: { tts: "google/gemini-2.5-flash-image" },
          },
          providers,
        },
      });

      const tool = descriptor(config);
      const schema = tool!.inputSchema as { properties: Record<string, { description: string }> };
      expect(schema.properties.model!.description).toContain("Suggested models");
      expect(schema.properties.model!.description).toContain("google/gemini-2.5-flash-image");
    });
  });

  describe("4. Tool already present - idempotency", () => {
    it("does not duplicate tool if already present", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            openrouter: {
              kind: "openai-compatible",
              baseUrl: "https://openrouter.ai/api",
              models: { "test-model": { mediaType: "image" } },
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();

      // First call - inject tool
      const result1 = finalizer(ctx, "agent:test:discord:channel:123");

      // Second call - should not duplicate
      const result2 = finalizer(result1, "agent:test:discord:channel:123");

      const mediaGenerateTools = result2.aggregated.tools.filter(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(mediaGenerateTools.length).toBe(1);
    });
  });

  describe("4. Backward compatibility with models.providers gemini fallback", () => {
    it("injects tool when old config shape has gemini provider in models.providers", () => {
      const config = makeConfig({
        mediaGeneration: undefined as unknown as ShoggothConfig["mediaGeneration"],
        models: {
          providers: {
            "gemini-default": {
              kind: "gemini",
              apiKey: "test-key",
              baseUrl: "https://generativelanguage.googleapis.com",
            },
          },
        },
      } as any);

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      // Should still work with old shape for backward compatibility
      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });
  });

  describe("5. Multiple providers", () => {
    it("injects tool when multiple providers have models", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            openrouter: {
              kind: "openai-compatible",
              baseUrl: "https://openrouter.ai/api",
              models: { "black-forest-labs/flux.2-klein-4b": { mediaType: "image" } },
            },
            google: {
              kind: "gemini",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: { "gemini-2.5-flash-image": { mediaType: "image" } },
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });

    it("injects tool when only one of multiple providers has models", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: {
            "empty-provider": {
              kind: "openai-compatible",
              baseUrl: "https://example.com",
              models: {},
            },
            google: {
              kind: "gemini",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: { "gemini-2.5-flash-image": { mediaType: "image" } },
            },
          },
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });
  });
});
