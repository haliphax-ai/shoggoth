import { describe, it, vi, beforeEach, expect } from "vitest";

// Mock the media generation service to avoid circular deps
vi.mock("../../src/media/media-generation-service", () => ({
  MediaGenerationService: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockResolvedValue({ status: "complete", path: "/tmp/out.png", mime_type: "image/png" }),
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

function makeConfig(overrides?: Partial<{ mediaGeneration: ShoggothConfig["mediaGeneration"] }>): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    operatorDirectory: "/tmp/operator",
    configDirectory: "/tmp/config",
    hitl: { defaultApprovalTimeoutMs: 300000, toolRisk: { read: "safe", write: "caution" }, bypassUpTo: "safe" },
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: [], poolScope: "global" },
    policy: {
      operator: { controlOps: { allow: ["*"], deny: [], review: [] }, tools: { allow: ["*"], deny: [], review: [] } },
      agent: { controlOps: { allow: ["*"], deny: [], review: [] }, tools: { allow: ["*"], deny: [], review: [] } },
      auditRedaction: { jsonPaths: [] },
    },
    models: { providers: [] },
    mediaGeneration: { providers: [], models: [] },
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

  describe("1. Tool injected when mediaGeneration.providers has entries", () => {
    it("injects builtin-media-generate when mediaGeneration.providers array has items", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [
            {
              id: "openai",
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
          models: [],
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      // Tool should be injected
      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });

    it("injects tool when mediaGeneration.providers has gemini provider", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [
            {
              id: "google",
              kind: "gemini",
              apiKey: "google-key",
              baseUrl: "https://generativelanguage.googleapis.com",
            },
          ],
          models: [],
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

  describe("2. Tool injected when mediaGeneration.models has entries", () => {
    it("injects builtin-media-generate when mediaGeneration.models array has items", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [],
          models: [
            { pattern: "dall-e-*", provider: "openai", adapter: "openai-images" },
          ],
        },
      });

      const finalizer = createMediaGenerateToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      // Tool should be injected when models has entries (even if providers is empty)
      const hasMediaGenerate = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-media-generate",
      );
      expect(hasMediaGenerate).toBe(true);
    });

    it("injects tool with multiple model patterns", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [],
          models: [
            { pattern: "dall-e-*", provider: "openai", adapter: "openai-images" },
            { pattern: "gemini-*-image", provider: "google", adapter: "gemini-generate-content" },
            { pattern: "veo-*", provider: "google", adapter: "gemini-long-running" },
          ],
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

  describe("3. Tool NOT injected when config absent or arrays empty", () => {
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

    it("does not inject tool when mediaGeneration.providers is empty", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [],
          models: [],
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

    it("does not inject tool when mediaGeneration.models is empty (providers also empty)", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [],
          models: [],
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

  describe("4. Tool already present - idempotency", () => {
    it("does not duplicate tool if already present", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [
            {
              id: "openai",
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
          models: [],
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

  describe("5. Works with both old and new config shapes", () => {
    it("injects tool when old config shape has gemini provider in models.providers", () => {
      // Old shape: mediaGeneration not defined, but models.providers has gemini
      const config = makeConfig({
        mediaGeneration: undefined as unknown as ShoggothConfig["mediaGeneration"],
        models: {
          providers: [
            {
              id: "gemini-default",
              kind: "gemini",
              apiKey: "test-key",
              baseUrl: "https://generativelanguage.googleapis.com",
            },
          ],
        },
      });

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

  describe("6. Different provider kinds", () => {
    it("injects tool for openai-compatible providers", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [
            {
              id: "local-ollama",
              kind: "openai-compatible",
              apiKey: "",
              baseUrl: "http://localhost:11434/v1",
            },
          ],
          models: [],
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

    it("injects tool for multiple providers of different kinds", () => {
      const config = makeConfig({
        mediaGeneration: {
          providers: [
            {
              id: "openai",
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
            },
            {
              id: "google",
              kind: "gemini",
              apiKey: "google-key",
              baseUrl: "https://generativelanguage.googleapis.com",
            },
          ],
          models: [],
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