import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock MediaGenerationService before importing integration-ops
// ---------------------------------------------------------------------------

const mockGenerate = vi.fn();

vi.mock("../../src/media/media-generation-service", () => ({
  MediaGenerationService: vi.fn().mockImplementation(function () {
    return { generate: mockGenerate };
  }),
}));

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
    mcp: { servers: [], poolScope: "global" },
    policy: DEFAULT_POLICY_CONFIG,
    models: {
      providers: [
        {
          id: "gemini-default",
          kind: "gemini" as const,
          apiKey: "test-api-key",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      ],
    },
    ...overrides,
  };
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
  };
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
    model: "nano-banana",
    prompt: "a cute cat",
    provider_id: "gemini-default",
    params: { kind: "image" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Control plane op: media_generate
// ---------------------------------------------------------------------------

describe("media_generate control op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Payload validation --------------------------------------------------

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

    it("rejects non-object payload", async () => {
      const req: WireRequest = {
        v: WIRE_VERSION,
        id: "test-1",
        op: "media_generate",
        payload: "not-an-object" as unknown as Record<string, unknown>,
      };
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });
  });

  // -- Provider validation -------------------------------------------------

  describe("provider validation", () => {
    it("rejects non-gemini provider", async () => {
      const ctx = makeCtx({
        models: {
          providers: [
            {
              id: "openai-prov",
              kind: "openai-compatible" as const,
              baseUrl: "https://api.openai.com/v1",
              apiKey: "oai-key",
            },
          ],
        },
      });
      const req = makeReq(validPayload({ provider_id: "openai-prov" }));
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);
      assert.ok(result != null);
      const r = result as { status: string; error?: string };
      assert.equal(r.status, "error");
      assert.ok(r.error!.includes("gemini"));
    });

    it("rejects unknown provider_id", async () => {
      const req = makeReq(validPayload({ provider_id: "nonexistent" }));
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());
      assert.ok(result != null);
      const r = result as { status: string; error?: string };
      assert.equal(r.status, "error");
      assert.ok(r.error!.includes("nonexistent"));
    });
  });

  // -- Service invocation --------------------------------------------------

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
      assert.equal(callArg.model, "nano-banana");
      assert.equal(callArg.prompt, "a cute cat");
      assert.equal(callArg.provider_id, "gemini-default");
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

      const req = makeReq(
        validPayload({ model: "veo-3.1-generate-preview", params: { kind: "video" } }),
      );
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.ok(result != null);
      const r = result as { status: string; operation_id?: string };
      assert.equal(r.status, "in_progress");
      assert.equal(r.operation_id, "operations/abc123");
    });
  });

  // -- Principal enforcement -----------------------------------------------

  describe("principal enforcement", () => {
    it("requires agent principal", async () => {
      mockGenerate.mockResolvedValueOnce({
        status: "complete",
        path: "/tmp/media/output.png",
        mime_type: "image/png",
      });

      const req = makeReq(validPayload());
      // Agent principal should succeed (not throw ERR_FORBIDDEN)
      const result = await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());
      assert.ok(result != null);
    });

    it("rejects operator principal", async () => {
      const req = makeReq(validPayload());
      // The op should either throw ERR_FORBIDDEN or return undefined (unknown op for operator)
      // Based on the pattern in integration-ops.ts, agent-only ops throw ERR_FORBIDDEN
      try {
        const result = await handleIntegrationControlOp(req, operatorPrincipal(), makeCtx());
        // If it returns undefined, the op is not recognized for operators
        assert.equal(result, undefined);
      } catch (err) {
        assert.ok(err instanceof IntegrationOpError);
        assert.equal((err as IntegrationOpError).code, "ERR_FORBIDDEN");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Config schema: mediaGeneration
// ---------------------------------------------------------------------------

describe("mediaGeneration config schema", () => {
  it("accepts valid mediaGeneration fragment", () => {
    const fragment = {
      mediaGeneration: {
        defaultProviderId: "gemini-default",
        outputDirectory: "/tmp/media",
        defaultTimeoutMs: 300000,
        modelAdapterMap: {
          "my-custom-model": "generateContent",
          "new-video-model": "longRunning",
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

  it("accepts mediaGeneration with only defaultProviderId", () => {
    const fragment = {
      mediaGeneration: {
        defaultProviderId: "my-gemini",
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("accepts mediaGeneration with only modelAdapterMap", () => {
    const fragment = {
      mediaGeneration: {
        modelAdapterMap: {
          "custom-image": "predict",
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

  it("rejects invalid modelAdapterMap values", () => {
    const fragment = {
      mediaGeneration: {
        modelAdapterMap: {
          "bad-model": "invalidAdapterType",
        },
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects non-positive defaultTimeoutMs", () => {
    const fragment = {
      mediaGeneration: {
        defaultTimeoutMs: -1,
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects non-integer defaultTimeoutMs", () => {
    const fragment = {
      mediaGeneration: {
        defaultTimeoutMs: 1.5,
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects empty string defaultProviderId", () => {
    const fragment = {
      mediaGeneration: {
        defaultProviderId: "",
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects empty string outputDirectory", () => {
    const fragment = {
      mediaGeneration: {
        outputDirectory: "",
      },
    };
    const result = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.equal(result.success, false);
  });

  it("rejects unknown fields in mediaGeneration (strict)", () => {
    const fragment = {
      mediaGeneration: {
        unknownField: true,
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
      mcp: { servers: [], poolScope: "global" },
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
      // no mediaGeneration — should be fine
    };
    const result = shoggothConfigSchema.safeParse(config);
    assert.equal(
      result.success,
      true,
      `Parse failed: ${result.success ? "" : result.error.message}`,
    );
  });

  it("full config schema accepts valid mediaGeneration", () => {
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
      mcp: { servers: [], poolScope: "global" },
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
        defaultProviderId: "gemini-default",
        outputDirectory: "/tmp/media/generated",
        defaultTimeoutMs: 300000,
        modelAdapterMap: {
          "custom-model": "generateContent",
          "video-model": "longRunning",
          "image-model": "predict",
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
