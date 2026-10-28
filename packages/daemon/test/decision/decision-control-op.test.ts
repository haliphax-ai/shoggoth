import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Mock DecisionService before importing integration-ops
// ---------------------------------------------------------------------------

const { mockEvaluate, MockDecisionService } = vi.hoisted(() => {
  const mockEvaluate = vi.fn();
  const MockDecisionService = vi.fn().mockImplementation(function () {
    return { evaluate: mockEvaluate };
  });
  MockDecisionService.fromConfig = vi.fn().mockImplementation(() => {
    return { evaluate: mockEvaluate };
  });
  return { mockEvaluate, MockDecisionService };
});

vi.mock("../../src/decision/decision-service", () => ({
  DecisionService: MockDecisionService,
}));

import { handleIntegrationControlOp, IntegrationOpError } from "../../src/control/integration-ops";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { WireRequest, AuthenticatedPrincipal } from "@shoggoth/authn";
import { WIRE_VERSION } from "@shoggoth/authn";
import {
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  shoggothDecisionConfigSchema,
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
    decision: {
      providers: {
        "typesafe-main": {
          kind: "typesafe",
          apiKey: "test-api-key",
          baseUrl: "https://api.typesafe.ai",
          models: { "jev-latest": {}, "jev-1.13.0": {} },
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
  } as unknown as IntegrationOpsContext;
}

function makeReq(payload: Record<string, unknown>): WireRequest {
  return {
    v: WIRE_VERSION,
    id: "test-1",
    op: "decision_evaluate",
    payload,
  };
}

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "jev-latest",
    state: "Help! My payouts have been failing for 3 days.",
    questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Control plane op: decision_evaluate
// ---------------------------------------------------------------------------

describe("decision_evaluate control op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("principal gating", () => {
    it("allows operator principal (CLI surface)", async () => {
      mockEvaluate.mockResolvedValueOnce({ status: "complete", model: "jev-latest", answers: {} });
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, operatorPrincipal(), makeCtx());
      assert.ok(result != null);
      assert.equal(mockEvaluate.mock.calls.length, 1);
    });
  });

  describe("payload validation", () => {
    it("allows missing model (config default applies downstream)", async () => {
      mockEvaluate.mockResolvedValueOnce({ status: "complete", model: "jev-latest", answers: {} });

      const req = makeReq(validPayload());
      delete (req.payload as Record<string, unknown>).model;
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.equal(mockEvaluate.mock.calls.length, 1);
      assert.equal(mockEvaluate.mock.calls[0]![0].model, undefined);
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

    it("rejects missing state", async () => {
      const req = makeReq(validPayload());
      delete (req.payload as Record<string, unknown>).state;
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("state"));
          return true;
        },
      );
    });

    it("rejects missing questions", async () => {
      const req = makeReq(validPayload());
      delete (req.payload as Record<string, unknown>).questions;
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          assert.ok(err.message.includes("questions"));
          return true;
        },
      );
    });

    it("rejects empty questions map", async () => {
      const req = makeReq(validPayload({ questions: {} }));
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects questions that are not an object", async () => {
      const req = makeReq(validPayload({ questions: "is it urgent?" }));
      await assert.rejects(
        () => handleIntegrationControlOp(req, agentPrincipal(), makeCtx()),
        (err: IntegrationOpError) => {
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });
  });

  describe("service invocation", () => {
    it("calls DecisionService.evaluate() with correct arguments", async () => {
      mockEvaluate.mockResolvedValueOnce({
        status: "complete",
        model: "jev-1.13.0",
        answers: { is_urgent: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 307, output_tokens: 20 },
      });

      const req = makeReq(validPayload());
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.equal(mockEvaluate.mock.calls.length, 1);
      const callArg = mockEvaluate.mock.calls[0]![0];
      assert.equal(callArg.model, "jev-latest");
      assert.equal(callArg.state, "Help! My payouts have been failing for 3 days.");
      assert.deepStrictEqual(callArg.questions, {
        is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
      });
    });

    it("passes through structured state and timeout_ms", async () => {
      mockEvaluate.mockResolvedValueOnce({ status: "complete", model: "jev-latest", answers: {} });

      const req = makeReq(validPayload({ state: { messages: [] }, timeout_ms: 15_000 }));
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      const callArg = mockEvaluate.mock.calls[0]![0];
      assert.deepStrictEqual(callArg.state, { messages: [] });
      assert.equal(callArg.timeout_ms, 15_000);
    });

    it("passes service error results through", async () => {
      mockEvaluate.mockResolvedValueOnce({
        status: "error",
        error: "No provider found for model: unknown-model",
      });

      const req = makeReq(validPayload({ model: "unknown-model" }));
      const result = (await handleIntegrationControlOp(req, agentPrincipal(), makeCtx())) as Record<
        string,
        unknown
      >;

      assert.equal(result.status, "error");
      assert.ok(String(result.error).includes("unknown-model"));
    });

    it("is invisible (returns undefined) when decision config is absent", async () => {
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(
        req,
        agentPrincipal(),
        makeCtx({ decision: undefined }),
      );

      assert.equal(result, undefined);
      assert.equal(MockDecisionService.fromConfig.mock.calls.length, 0);
      assert.equal(mockEvaluate.mock.calls.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature gating: with no decision models configured at all, the op must be
  // indistinguishable from a nonexistent op (ERR_UNKNOWN_OP downstream).
  // ---------------------------------------------------------------------------

  describe("feature gating (no models configured)", () => {
    it("is invisible when providers exist but have no models", async () => {
      const ctx = makeCtx({
        decision: {
          providers: {
            "typesafe-main": {
              kind: "typesafe",
              baseUrl: "https://api.typesafe.ai",
              models: {},
            },
          },
        },
      });
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.equal(result, undefined);
      assert.equal(MockDecisionService.fromConfig.mock.calls.length, 0);
    });

    it("is invisible to operators when unconfigured (no ERR_FORBIDDEN leak)", async () => {
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(
        req,
        operatorPrincipal(),
        makeCtx({ decision: undefined }),
      );

      assert.equal(result, undefined);
    });

    it("is invisible with an invalid payload when unconfigured (no validation leak)", async () => {
      const req = makeReq({});
      const result = await handleIntegrationControlOp(
        req,
        agentPrincipal(),
        makeCtx({ decision: undefined }),
      );

      assert.equal(result, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// Config schema: decision
// ---------------------------------------------------------------------------

describe("decision config schema", () => {
  it("accepts valid decision with providers and nested models", () => {
    const fragment = {
      decision: {
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            apiKeyEnv: "TYPESAFE_API_KEY",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("accepts decision with only providers array", () => {
    const fragment = { decision: { providers: {} } };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("accepts empty decision object", () => {
    const fragment = { decision: {} };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("rejects unknown provider kind", () => {
    const fragment = {
      decision: {
        providers: { p1: { kind: "openai", baseUrl: "https://example.com", models: {} } },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(!parsed.success);
  });

  it("rejects provider without baseUrl", () => {
    const fragment = {
      decision: {
        providers: { p1: { kind: "typesafe", models: {} } },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(!parsed.success);
  });

  it("rejects a model record entry with an empty name key", () => {
    const fragment = {
      decision: {
        providers: {
          p1: {
            kind: "typesafe",
            baseUrl: "https://example.com",
            models: { "": {} },
          },
        },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(!parsed.success);
  });

  it("rejects unknown fields in decision (strict)", () => {
    const fragment = {
      decision: {
        defaultProviderId: "typesafe-main",
        providers: {},
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(!parsed.success);
  });

  it("decision is optional in full config schema", () => {
    const parsed = shoggothConfigSchema.safeParse({
      ...makeConfig({ decision: undefined }),
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("full config schema accepts valid decision config", () => {
    const parsed = shoggothConfigSchema.safeParse(makeConfig());
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("standalone schema defaults providers to empty object", () => {
    const parsed = shoggothDecisionConfigSchema.safeParse({});
    assert.ok(parsed.success);
    if (parsed.success) {
      assert.deepStrictEqual(parsed.data.providers, {});
    }
  });

  it("accepts a defaultModel in provider/model-id format matching a configured model", () => {
    const fragment = {
      decision: {
        defaultModel: "typesafe-main/jev-latest",
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("rejects a defaultModel that matches no configured model", () => {
    const fragment = {
      decision: {
        defaultModel: "typesafe-main/jev-typo",
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    // Referential checks (defaultModel must resolve against providers) run on
    // the full config schema — config fragments are partial layers and cannot
    // resolve refs that may be declared in a different layer.
    const parsed = shoggothDecisionConfigSchema.safeParse(fragment.decision);
    assert.ok(!parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("rejects a defaultModel when no providers are configured", () => {
    const fragment = { decision: { defaultModel: "typesafe-main/jev-latest", providers: {} } };
    const parsed = shoggothDecisionConfigSchema.safeParse(fragment.decision);
    assert.ok(!parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("rejects a raw defaultModel without the provider/model-id format", () => {
    const fragment = {
      decision: {
        defaultModel: "jev-latest",
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    const parsed = shoggothDecisionConfigSchema.safeParse(fragment.decision);
    assert.ok(!parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("rejects a defaultModel whose provider prefix does not match", () => {
    const fragment = {
      decision: {
        defaultModel: "wrong-provider/jev-latest",
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    const parsed = shoggothDecisionConfigSchema.safeParse(fragment.decision);
    assert.ok(!parsed.success, JSON.stringify(parsed.error?.issues));
  });

  it("accepts decision without a defaultModel", () => {
    const fragment = {
      decision: {
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: { "jev-latest": {} },
          },
        },
      },
    };
    const parsed = shoggothConfigFragmentSchema.safeParse(fragment);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });
});
