import { describe, it, vi, beforeEach, expect } from "vitest";

vi.mock("../../src/config-hot-reload", () => ({
  getConfig: vi.fn(),
}));

import { createRerankToolFinalizer } from "../../src/sessions/session-mcp-tool-context";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import type { ShoggothConfig } from "@shoggoth/shared";

function makeConfig(overrides?: Partial<{ rerank: ShoggothConfig["rerank"] }>): ShoggothConfig {
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
    models: { providers: [] },
    rerank: { providers: [] },
    ...overrides,
  } as ShoggothConfig;
}

const rerankConfigWithModels = {
  defaultModel: "openrouter-cohere/cohere/rerank-v3.5",
  providers: [
    {
      id: "openrouter-cohere",
      kind: "cohere" as const,
      baseUrl: "https://openrouter.ai/api",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [
        { name: "cohere/rerank-v3.5" },
        { name: "nvidia/llama-nemotron-rerank-vl-1b-v2:free" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests for builtin-rerank tool finalizer
// ---------------------------------------------------------------------------

describe("createRerankToolFinalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool injection", () => {
    it("injects builtin-rerank when a provider has models", () => {
      const config = makeConfig({ rerank: rerankConfigWithModels });
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasRerank = result.aggregated.tools.some((t) => t.namespacedName === "builtin-rerank");
      expect(hasRerank).toBe(true);
    });

    it("does not inject tool when rerank config is undefined", () => {
      const config = makeConfig({
        rerank: undefined as unknown as ShoggothConfig["rerank"],
      });
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasRerank = result.aggregated.tools.some((t) => t.namespacedName === "builtin-rerank");
      expect(hasRerank).toBe(false);
    });

    it("does not inject tool when providers array is empty", () => {
      const config = makeConfig({ rerank: { providers: [] } });
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasRerank = result.aggregated.tools.some((t) => t.namespacedName === "builtin-rerank");
      expect(hasRerank).toBe(false);
    });

    it("does not inject tool when providers have no models", () => {
      const config = makeConfig({
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
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasRerank = result.aggregated.tools.some((t) => t.namespacedName === "builtin-rerank");
      expect(hasRerank).toBe(false);
    });

    it("does not duplicate an already-present builtin-rerank tool", () => {
      const config = makeConfig({ rerank: rerankConfigWithModels });
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();

      const once = finalizer(ctx, "agent:test:discord:channel:123");
      const twice = finalizer(once, "agent:test:discord:channel:123");

      const count = twice.aggregated.tools.filter(
        (t) => t.namespacedName === "builtin-rerank",
      ).length;
      expect(count).toBe(1);
    });
  });

  describe("tool descriptor", () => {
    function descriptorFor(config: ShoggothConfig) {
      const finalizer = createRerankToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");
      return result.aggregated.tools.find((t) => t.namespacedName === "builtin-rerank")!;
    }

    it("makes model optional and names the default model when configured", () => {
      const descriptor = descriptorFor(makeConfig({ rerank: rerankConfigWithModels }));

      const schema = descriptor.inputSchema as {
        required?: string[];
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.required).toEqual(["query", "documents"]);
      expect(schema.properties?.model?.description).toContain(
        "openrouter-cohere/cohere/rerank-v3.5",
      );
      expect(descriptor.description).toContain("openrouter-cohere/cohere/rerank-v3.5");
    });

    it("makes model required when no default model is configured", () => {
      const descriptor = descriptorFor(
        makeConfig({
          rerank: { providers: rerankConfigWithModels.providers },
        }),
      );

      const schema = descriptor.inputSchema as { required?: string[] };
      expect(schema.required).toEqual(["model", "query", "documents"]);
      expect(descriptor.description).toContain("No default model");
    });

    it("exposes query, documents, top_n, and timeout_ms inputs", () => {
      const descriptor = descriptorFor(makeConfig({ rerank: rerankConfigWithModels }));

      const schema = descriptor.inputSchema as {
        properties?: Record<string, { type?: string }>;
      };
      expect(schema.properties?.query?.type).toBe("string");
      expect(schema.properties?.documents?.type).toBe("array");
      expect(schema.properties?.top_n?.type).toBe("number");
      expect(schema.properties?.timeout_ms?.type).toBe("number");
    });
  });
});
