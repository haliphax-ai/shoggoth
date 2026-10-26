import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// DI: inject a fake MediaGenerationService factory into the integration ops
// context instead of mocking the module (vi.mock is import-order dependent
// under --no-isolate).

const mockGenerate = vi.fn();

function makeFakeMediaGenerationService() {
  return { generate: mockGenerate, poll: vi.fn() };
}

import { handleIntegrationControlOp, IntegrationOpError } from "../../src/control/integration-ops";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { WireRequest, AuthenticatedPrincipal } from "@shoggoth/authn";
import { WIRE_VERSION } from "@shoggoth/authn";
import {
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  DEFAULT_HITL_CONFIG,
  DEFAULT_POLICY_CONFIG,
  type ShoggothConfig,
} from "@shoggoth/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentPrincipal(
  sessionId = "agent:test:discord:channel:00000000-0000-0000-0000-000000000001",
): AuthenticatedPrincipal {
  return { kind: "agent", sessionId };
}

function operatorPrincipal(): AuthenticatedPrincipal {
  return { kind: "operator", operatorId: "op-test" };
}

function makeConfig(overrides?: Partial<ShoggothConfig>): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: "/tmp/state.db",
    socketPath: "/tmp/c.sock",
    workspacesRoot: "/tmp/workspaces",
    secretsDirectory: "/tmp/secrets",
    inboundMediaRoot: "/tmp/media",
    operatorDirectory: "/tmp/operator",
    configDirectory: "/tmp/config",
    hitl: DEFAULT_HITL_CONFIG,
    memory: { paths: ["memory"], embeddings: { enabled: false } },
    skills: { scanRoots: ["skills"], disabledIds: [] },
    plugins: [],
    mcp: { servers: {}, poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    models: {
      providers: {
        "gemini-default": {
          kind: "gemini" as const,
          apiKey: "test-api-key",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      },
    },
    mediaGeneration: {
      providers: {
        "gemini-default": {
          kind: "gemini",
          apiKey: "test-api-key",
          baseUrl: "https://generativelanguage.googleapis.com",
          models: {
            "gemini-2.5-flash-image": { mediaType: "image" },
            "imagen-4.0-fast-generate-001": { mediaType: "image", adapter: "gemini-predict" },
            "veo-3.1-generate-preview": { mediaType: "video" },
          },
        },
      },
    },
    ...overrides,
  } as ShoggothConfig;
}

function makeCtx(configOverrides?: Partial<ShoggothConfig>): IntegrationOpsContext {
  return {
    config: makeConfig(configOverrides),
    stateDb: undefined,
    acpxStore: undefined,
    sessions: undefined,
    sessionManager: undefined,
    acpxSupervisor: undefined,
    recordIntegrationAudit: () => {},
    createMediaGenerationService: makeFakeMediaGenerationService,
  } as unknown as IntegrationOpsContext;
}

function makeReq(payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: "test-1",
    op: "media_generate",
    payload,
  };
}

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "gemini-2.5-flash-image",
    prompt: "a cute cat",
    params: { kind: "image" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Control plane op: media_generate
// ---------------------------------------------------------------------------

describe("media_generate control op - Multi-Provider Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("payload validation", () => {
    it("rejects missing model", async () => {
      const req = makeReq(validPayload({ model: undefined }));
      delete (req.payload as Record<string, unknown>).model;
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("model"));
          return true;
        },
      );
    });

    it("rejects empty string model", async () => {
      const req = makeReq(validPayload({ model: "" }));
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects missing prompt", async () => {
      const req = makeReq(validPayload({ prompt: undefined }));
      delete (req.payload as Record<string, unknown>).prompt;
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("prompt"));
          return true;
        },
      );
    });

    it("rejects missing params", async () => {
      const req = makeReq(validPayload({ params: undefined }));
      delete (req.payload as Record<string, unknown>).params;
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("params"));
          return true;
        },
      );
    });

    it("rejects params without kind", async () => {
      const req = makeReq(validPayload({ params: { aspectRatio: "16:9" } }));
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("kind"));
          return true;
        },
      );
    });
  });

  describe("model-based provider resolution", () => {
    it("resolves provider from model match", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload({ model: "gemini-2.5-flash-image" }));
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.equal(mockGenerate.mock.calls.length, 1);
      const callArg = mockGenerate.mock.calls[0][0];
      assert.equal(callArg.model, "gemini-2.5-flash-image");
      assert.equal(callArg.prompt, "a cute cat");
      assert.deepStrictEqual(callArg.params, { kind: "image" });
    });

    it("returns error when model doesn't match any configured model", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "error",
        error: "No provider/adapter found for model: unknown-model",
      });

      const ctx = makeCtx({
        mediaGeneration: {
          providers: {
            test: {
              kind: "gemini",
              apiKey: "key",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: { "dall-e-3": { mediaType: "image" } },
            },
          },
        },
      } as any);

      const req = makeReq(validPayload({ model: "unknown-model" }));
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.ok(result != null);
      const r = result as { status: string; error?: string };
      assert.equal(r.status, "error");
      assert.ok(r.error!.includes("unknown-model"));
    });

    it("routes to correct adapter based on model", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.mp4",
        mime_type: "video/mp4",
      });

      const req = makeReq(
        validPayload({ model: "veo-3.1-generate-preview", params: { kind: "video" } }),
      );
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.ok(result != null);
      const r = result as { status: string };
      assert.equal(r.status, "complete");
    });
  });

  describe("openai-compatible provider support", () => {
    it("works with openai-compatible provider when model matches", async () => {
      const ctx = makeCtx({
        mediaGeneration: {
          providers: {
            openai: {
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
              models: {
                "dall-e-3": { mediaType: "image", adapter: "openai-images" },
                "gpt-image-1": { mediaType: "image", adapter: "openai-chat-image" },
              },
            },
          },
        },
      } as any);

      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload({ model: "dall-e-3" }));
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.ok(result != null);
      const r = result as { status: string };
      assert.equal(r.status, "complete");
    });

    it("routes to openai-images for dall-e models", async () => {
      const ctx = makeCtx({
        mediaGeneration: {
          providers: {
            openai: {
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
              models: { "dall-e-3": { mediaType: "image", adapter: "openai-images" } },
            },
          },
        },
      } as any);

      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload({ model: "dall-e-3" }));
      await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.equal(mockGenerate.mock.calls.length, 1);
      const callArg = mockGenerate.mock.calls[0][0];
      assert.equal(callArg.model, "dall-e-3");
    });

    it("routes to openai-chat-image for gpt-image models", async () => {
      const ctx = makeCtx({
        mediaGeneration: {
          providers: {
            openai: {
              kind: "openai-compatible",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
              models: { "gpt-image-1": { mediaType: "image", adapter: "openai-chat-image" } },
            },
          },
        },
      } as any);

      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload({ model: "gpt-image-1" }));
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.ok(result != null);
      const r = result as { status: string };
      assert.equal(r.status, "complete");
    });
  });

  describe("service invocation", () => {
    it("calls MediaGenerationService.generate() with correct arguments", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(
        validPayload({
          output_path: "/tmp/media/output.png",
          timeout_ms: 60000,
        }),
      );
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.equal(mockGenerate.mock.calls.length, 1);
      const callArg = mockGenerate.mock.calls[0][0];
      assert.equal(callArg.model, "gemini-2.5-flash-image");
      assert.equal(callArg.prompt, "a cute cat");
      assert.deepStrictEqual(callArg.params, { kind: "image" });
    });

    it("returns complete result with path and mime_type on success", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/generated.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.ok(result != null);
      const r = result as { status: string; path?: string; mime_type?: string };
      assert.equal(r.status, "complete");
      assert.equal(r.path, "/tmp/media/generated.png");
      assert.equal(r.mime_type, "image/png");
    });

    it("returns error result on service failure", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "error",
        error: "API rate limit exceeded",
      });

      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.ok(result != null);
      const r = result as { status: string; error?: string };
      assert.equal(r.status, "error");
      assert.equal(r.error, "API rate limit exceeded");
    });

    it("returns in_progress result for async models", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "in_progress",
        operation_id: "operations/abc123",
      });

      const ctx = makeCtx({
        mediaGeneration: {
          providers: {
            test: {
              kind: "gemini",
              apiKey: "key",
              baseUrl: "https://generativelanguage.googleapis.com",
              models: { "veo-3.1-generate-preview": { mediaType: "video" } },
            },
          },
        },
      } as any);

      const req = makeReq(
        validPayload({ model: "veo-3.1-generate-preview", params: { kind: "video" } }),
      );
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.ok(result != null);
      const r = result as { status: string; operation_id?: string };
      assert.equal(r.status, "in_progress");
      assert.equal(r.operation_id, "operations/abc123");
    });
  });

  describe("principal enforcement", () => {
    it("requires agent principal", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());
      assert.ok(result != null);
    });

    it("allows operator principal (CLI surface)", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, operatorPrincipal(), makeCtx());
      assert.ok(result != null);
      assert.equal(mockGenerate.mock.calls.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Config schema: mediaGeneration - New Shape Tests
// ---------------------------------------------------------------------------

describe("mediaGeneration config schema - New Multi-Provider Shape", () => {
  it("accepts valid mediaGeneration with providers and nested models", () => {
    const fragment = {
      mediaGeneration: {
        providers: {
          openai: {
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
            models: { "dall-e-3": { mediaType: "image", adapter: "openai-images" } },
          },
          google: {
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: {
              "gemini-2.5-flash-image": { mediaType: "image" },
              "veo-3.1": { mediaType: "video" },
            },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("accepts mediaGeneration with only providers array", () => {
    const fragment = {
      mediaGeneration: {
        providers: {
          "my-provider": {
            kind: "openai-compatible",
            apiKey: "key",
            baseUrl: "https://api.example.com",
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("accepts mediaGeneration with providers that have no models", () => {
    const fragment = {
      mediaGeneration: {
        providers: {
          "my-provider": {
            kind: "openai-compatible",
            baseUrl: "https://api.example.com",
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("accepts empty mediaGeneration object", () => {
    const fragment = { mediaGeneration: {} };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("rejects old shape with defaultProviderId", () => {
    const fragment = {
      mediaGeneration: {
        defaultProviderId: "gemini-default",
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects old shape with modelAdapterMap", () => {
    const fragment = {
      mediaGeneration: {
        modelAdapterMap: {
          "custom-model": "generateContent",
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects invalid adapter values in provider models", () => {
    const fragment = {
      mediaGeneration: {
        providers: {
          test: {
            kind: "openai-compatible",
            baseUrl: "https://example.com",
            models: { "bad-model": { mediaType: "image", adapter: "invalidAdapter" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("accepts defaults with valid provider-id/model-id references", () => {
    const fragment = {
      mediaGeneration: {
        defaults: {
          image: "google/gemini-2.5-flash-image",
          video: "google/veo-3.1",
          audio: "google/lyria-3-pro-preview",
          suggestions: {
            music: "google/lyria-3-pro-preview",
            tts: "google/gemini-2.5-flash-preview-tts",
          },
        },
        providers: {
          google: {
            kind: "gemini",
            apiKey: "google-key",
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
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("accepts mediaGeneration with partial defaults", () => {
    const fragment = {
      mediaGeneration: {
        defaults: { image: "google/gemini-2.5-flash-image" },
        providers: {
          google: {
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: { "gemini-2.5-flash-image": { mediaType: "image" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, true);
  });

  it("rejects a default that matches no configured model", () => {
    const fragment = {
      mediaGeneration: {
        defaults: { image: "google/nonexistent-model" },
        providers: {
          google: {
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: { "gemini-2.5-flash-image": { mediaType: "image" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects a default without provider-id/model-id format", () => {
    const fragment = {
      mediaGeneration: {
        defaults: { image: "gemini-2.5-flash-image" },
        providers: {
          google: {
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: { "gemini-2.5-flash-image": { mediaType: "image" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects an unknown suggestion kind", () => {
    const fragment = {
      mediaGeneration: {
        defaults: { suggestions: { podcast: "google/lyria-3-pro-preview" } },
        providers: {
          google: {
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: { "lyria-3-pro-preview": { mediaType: "audio" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects a suggestion that matches no configured model", () => {
    const fragment = {
      mediaGeneration: {
        defaults: { suggestions: { tts: "google/missing-tts" } },
        providers: {
          google: {
            kind: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: { "lyria-3-pro-preview": { mediaType: "audio" } },
          },
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects unknown fields in mediaGeneration (strict)", () => {
    const fragment = {
      mediaGeneration: {
        unknownField: true,
        providers: {},
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("mediaGeneration is optional in full config schema", () => {
    const config = {
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
    };
    const result = shoggothConfigSchema.safeParse(config);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("full config schema accepts valid mediaGeneration with new shape", () => {
    const config = {
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
      mediaGeneration: {
        providers: {
          openai: {
            kind: "openai-compatible",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
            models: {
              "dall-e-3": { mediaType: "image", adapter: "openai-images" },
              "gpt-image-1": { mediaType: "image", adapter: "openai-chat-image" },
            },
          },
          google: {
            kind: "gemini",
            apiKey: "google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: {
              "gemini-2.5-flash-image": { mediaType: "image" },
              "imagen-4.0-fast-generate-001": {
                mediaType: "image",
                adapter: "gemini-predict",
              },
              "veo-3.1": { mediaType: "video" },
            },
          },
        },
      },
    };
    const result = shoggothConfigSchema.safeParse(config);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });
});
