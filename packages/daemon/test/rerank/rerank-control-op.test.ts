import { describe, it, vi, beforeEach } from "vitest";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Mock RerankService before importing integration-ops
// ---------------------------------------------------------------------------

const { mockRerank, MockRerankService } = vi.hoisted(() => {
  const mockRerank = vi.fn();
  const MockRerankService = vi.fn().mockImplementation(function () {
    return { rerank: mockRerank };
  });
  MockRerankService.fromConfig = vi.fn().mockImplementation(() => {
    return { rerank: mockRerank };
  });
  return { mockRerank, MockRerankService };
});

vi.mock("../../src/rerank/rerank-service", () => ({
  RerankService: MockRerankService,
}));

import { handleIntegrationControlOp, IntegrationOpError } from "../../src/control/integration-ops";
import type { IntegrationOpsContext } from "../../src/control/integration-ops";
import type { WireRequest, AuthenticatedPrincipal } from "@shoggoth/authn";
import { WIRE_VERSION } from "@shoggoth/authn";
import {
  shoggothRerankConfigSchema,
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
    rerank: {
      providers: [
        {
          id: "openrouter-cohere",
          kind: "cohere",
          apiKey: "test-api-key",
          baseUrl: "https://openrouter.ai/api",
          models: [{ name: "cohere/rerank-v3.5" }],
        },
      ],
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
    op: "rerank_documents",
    payload,
  };
}

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "cohere/rerank-v3.5",
    query: "Where can I review my billing history?",
    documents: ["Billing history lives in the dashboard.", "Shipping policies for orders."],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Control plane op: rerank_documents
// ---------------------------------------------------------------------------

describe("rerank_documents control op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("principal gating", () => {
    it("rejects operator principal", async () => {
      await assert.rejects(
        () => handleIntegrationControlOp(makeReq(validPayload()), operatorPrincipal(), makeCtx()),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_FORBIDDEN");
          return true;
        },
      );
    });
  });

  describe("payload validation", () => {
    it("rejects empty string model", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ model: "" })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects missing query", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq({ model: "cohere/rerank-v3.5", documents: ["a"] }),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects blank query", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ query: "   " })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects missing documents", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq({ model: "cohere/rerank-v3.5", query: "q" }),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects empty documents array", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ documents: [] })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects non-string documents", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ documents: ["ok", 42] })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects non-positive top_n", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ top_n: 0 })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });

    it("rejects non-numeric top_n", async () => {
      await assert.rejects(
        () =>
          handleIntegrationControlOp(
            makeReq(validPayload({ top_n: "two" })),
            agentPrincipal(),
            makeCtx(),
          ),
        (err: unknown) => {
          assert.ok(err instanceof IntegrationOpError);
          assert.equal(err.code, "ERR_INVALID_PAYLOAD");
          return true;
        },
      );
    });
  });

  describe("service invocation", () => {
    it("calls RerankService.rerank() with correct arguments", async () => {
      mockRerank.mockResolvedValueOnce({
        status: "complete",
        model: "cohere/rerank-v3.5",
        results: [{ index: 0, relevance_score: 0.97 }],
      });

      const req = makeReq(validPayload());
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      assert.equal(mockRerank.mock.calls.length, 1);
      const callArg = mockRerank.mock.calls[0]![0];
      assert.equal(callArg.model, "cohere/rerank-v3.5");
      assert.equal(callArg.query, "Where can I review my billing history?");
      assert.deepStrictEqual(callArg.documents, [
        "Billing history lives in the dashboard.",
        "Shipping policies for orders.",
      ]);
    });

    it("passes through top_n and timeout_ms", async () => {
      mockRerank.mockResolvedValueOnce({ status: "complete", model: "m", results: [] });

      const req = makeReq(validPayload({ top_n: 2, timeout_ms: 15_000 }));
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      const callArg = mockRerank.mock.calls[0]![0];
      assert.equal(callArg.top_n, 2);
      assert.equal(callArg.timeout_ms, 15_000);
    });

    it("omits model so the configured default applies", async () => {
      mockRerank.mockResolvedValueOnce({ status: "complete", model: "m", results: [] });

      const { model: _omitted, ...withoutModel } = validPayload();
      const req = makeReq(withoutModel);
      await handleIntegrationControlOp(req, agentPrincipal(), makeCtx());

      const callArg = mockRerank.mock.calls[0]![0];
      assert.equal(callArg.model, undefined);
    });

    it("passes service error results through", async () => {
      mockRerank.mockResolvedValueOnce({
        status: "error",
        error: "Rerank error 400: Model does not exist",
      });

      const req = makeReq(validPayload({ model: "unknown-model" }));
      const result = (await handleIntegrationControlOp(req, agentPrincipal(), makeCtx())) as Record<
        string,
        unknown
      >;

      assert.equal(result.status, "error");
      assert.ok(String(result.error).includes("does not exist"));
    });

    it("is invisible (returns undefined) when rerank config is absent", async () => {
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(
        req,
        agentPrincipal(),
        makeCtx({ rerank: undefined }),
      );

      assert.equal(result, undefined);
      assert.equal(MockRerankService.fromConfig.mock.calls.length, 0);
      assert.equal(mockRerank.mock.calls.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Feature gating: with no rerank models configured at all, the op must be
  // indistinguishable from a nonexistent op (ERR_UNKNOWN_OP downstream).
  // -------------------------------------------------------------------------

  describe("feature gating (no models configured)", () => {
    it("is invisible when providers exist but have no models", async () => {
      const ctx = makeCtx({
        rerank: {
          providers: [
            {
              id: "openrouter-cohere",
              kind: "cohere",
              baseUrl: "https://openrouter.ai/api",
              models: [],
            },
          ],
        },
      });
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(req, agentPrincipal(), ctx);

      assert.equal(result, undefined);
      assert.equal(MockRerankService.fromConfig.mock.calls.length, 0);
    });

    it("is invisible to operators when unconfigured (no ERR_FORBIDDEN leak)", async () => {
      const req = makeReq(validPayload());
      const result = await handleIntegrationControlOp(
        req,
        operatorPrincipal(),
        makeCtx({ rerank: undefined }),
      );

      assert.equal(result, undefined);
    });

    it("is invisible with an invalid payload when unconfigured (no validation leak)", async () => {
      const req = makeReq({});
      const result = await handleIntegrationControlOp(
        req,
        agentPrincipal(),
        makeCtx({ rerank: undefined }),
      );

      assert.equal(result, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// shoggothRerankConfigSchema validation
// ---------------------------------------------------------------------------

describe("shoggothRerankConfigSchema", () => {
  const validProvider = {
    id: "p1",
    kind: "cohere" as const,
    baseUrl: "https://api.cohere.com",
    models: [],
  };

  it("accepts a valid config", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({ providers: [validProvider] });
    assert.ok(parsed.success);
  });

  it("rejects unknown provider kind", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      providers: [{ id: "p1", kind: "openai", baseUrl: "https://example.com", models: [] }],
    });
    assert.ok(!parsed.success);
  });

  it("rejects provider without baseUrl", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      providers: [{ id: "p1", kind: "cohere", models: [] }],
    });
    assert.ok(!parsed.success);
  });

  it("rejects model without name", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      providers: [
        {
          id: "p1",
          kind: "cohere",
          baseUrl: "https://example.com",
          models: [{}],
        },
      ],
    });
    assert.ok(!parsed.success);
  });

  it("rejects unknown fields (strict)", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      nope: true,
      providers: [validProvider],
    });
    assert.ok(!parsed.success);
  });

  it("rejects a defaultModel that matches no configured model", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      defaultModel: "p1/rerank-typo",
      providers: [
        {
          id: "p1",
          kind: "cohere",
          baseUrl: "https://example.com",
          models: [{ name: "rerank-v3.5" }],
        },
      ],
    });
    assert.ok(!parsed.success);
  });

  it("rejects a defaultModel when no providers are configured", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      defaultModel: "p1/rerank-v3.5",
      providers: [],
    });
    assert.ok(!parsed.success);
  });

  it("rejects a raw defaultModel without the provider/model-id format", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      defaultModel: "rerank-v3.5",
      providers: [
        {
          id: "p1",
          kind: "cohere",
          baseUrl: "https://example.com",
          models: [{ name: "rerank-v3.5" }],
        },
      ],
    });
    assert.ok(!parsed.success);
  });

  it("accepts a defaultModel matching a configured provider/model pair", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      defaultModel: "p1/rerank-v3.5",
      providers: [
        {
          id: "p1",
          kind: "cohere",
          baseUrl: "https://example.com",
          models: [{ name: "rerank-v3.5" }],
        },
      ],
    });
    assert.ok(parsed.success);
  });

  it("accepts memorySearch.enabled; absent stanza stays absent, omitted enabled defaults true", () => {
    const disabled = shoggothRerankConfigSchema.safeParse({
      memorySearch: { enabled: false },
      providers: [validProvider],
    });
    assert.ok(disabled.success);
    assert.equal(disabled.success && disabled.data.memorySearch?.enabled, false);

    const defaulted = shoggothRerankConfigSchema.safeParse({
      memorySearch: {},
      providers: [validProvider],
    });
    assert.ok(defaulted.success);
    assert.equal(defaulted.success && defaulted.data.memorySearch?.enabled, true);

    const absent = shoggothRerankConfigSchema.safeParse({ providers: [validProvider] });
    assert.ok(absent.success);
    assert.equal(absent.success && absent.data.memorySearch, undefined);
  });

  it("rejects a non-boolean memorySearch.enabled", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      memorySearch: { enabled: "yes" },
      providers: [validProvider],
    });
    assert.ok(!parsed.success);
  });

  it("rejects unknown fields inside memorySearch (strict)", () => {
    const parsed = shoggothRerankConfigSchema.safeParse({
      memorySearch: { enabled: true, nope: true },
      providers: [validProvider],
    });
    assert.ok(!parsed.success);
  });
});
