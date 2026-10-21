import { describe, it, vi, beforeEach, expect } from "vitest";

vi.mock("../../src/config-hot-reload", () => ({
  getConfig: vi.fn(),
}));

import { createDecisionToolFinalizer } from "../../src/sessions/session-mcp-tool-context";
import { buildBuiltinOnlySessionMcpToolContext } from "../../src/sessions/session-mcp-tool-context";
import type { ShoggothConfig } from "@shoggoth/shared";

function makeConfig(overrides?: Partial<{ decision: ShoggothConfig["decision"] }>): ShoggothConfig {
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
    decision: { providers: {} },
    ...overrides,
  } as ShoggothConfig;
}

const decisionConfigWithModels = {
  defaultModel: "typesafe-main/jev-latest",
  providers: {
    "typesafe-main": {
      kind: "typesafe" as const,
      baseUrl: "https://api.typesafe.ai",
      apiKeyEnv: "TYPESAFE_API_KEY",
      models: [{ name: "jev-latest" }, { name: "jev-1.13.0" }],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests for builtin-decision tool finalizer
// ---------------------------------------------------------------------------

describe("createDecisionToolFinalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool injection", () => {
    it("injects builtin-decision when a provider has models", () => {
      const config = makeConfig({ decision: decisionConfigWithModels });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasDecision = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-decision",
      );
      expect(hasDecision).toBe(true);
    });

    it("does not inject tool when decision config is undefined", () => {
      const config = makeConfig({
        decision: undefined as unknown as ShoggothConfig["decision"],
      });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasDecision = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-decision",
      );
      expect(hasDecision).toBe(false);
    });

    it("does not inject tool when providers array is empty", () => {
      const config = makeConfig({ decision: { providers: {} } });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasDecision = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-decision",
      );
      expect(hasDecision).toBe(false);
    });

    it("does not inject tool when providers have no models", () => {
      const config = makeConfig({
        decision: {
          providers: {
            "typesafe-main": {
              kind: "typesafe",
              baseUrl: "https://api.typesafe.ai",
              models: [],
            },
          },
        },
      });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const hasDecision = result.aggregated.tools.some(
        (t) => t.namespacedName === "builtin-decision",
      );
      expect(hasDecision).toBe(false);
    });

    it("does not duplicate an already-present builtin-decision tool", () => {
      const config = makeConfig({ decision: decisionConfigWithModels });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const once = finalizer(ctx, "agent:test:discord:channel:123");
      const twice = finalizer(once, "agent:test:discord:channel:123");

      const count = twice.aggregated.tools.filter(
        (t) => t.namespacedName === "builtin-decision",
      ).length;
      expect(count).toBe(1);
    });
  });

  describe("tool descriptor", () => {
    function getDescriptor(config = makeConfig({ decision: decisionConfigWithModels })) {
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");
      const tool = result.aggregated.tools.find((t) => t.namespacedName === "builtin-decision");
      expect(tool).toBeDefined();
      return tool!;
    }

    it("exposes model, state, and questions inputs", () => {
      const tool = getDescriptor();
      const schema = tool.inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(Object.keys(schema.properties).sort()).toEqual([
        "model",
        "questions",
        "state",
        "timeout_ms",
      ]);
      // model is optional when a default model is configured
      expect(schema.required.sort()).toEqual(["questions", "state"]);
    });

    it("names the default model and provider in the description", () => {
      const tool = getDescriptor();
      expect(tool.description).toContain("jev-latest");
      expect(tool.description).toContain("typesafe-main");
      expect(tool.description).toContain("default");
    });

    it("describes the model input as optional when a default is configured", () => {
      const tool = getDescriptor();
      const schema = tool.inputSchema as { properties: Record<string, { description?: string }> };
      const desc = schema.properties.model?.description ?? "";
      expect(desc).toContain("jev-latest");
      expect(desc).toContain("typesafe-main");
      expect(desc.toLowerCase()).toContain("optional");
    });

    it("requires model and flags it in descriptions when no default is configured", () => {
      const { defaultModel: _omitted, ...noDefault } = decisionConfigWithModels;
      const tool = getDescriptor(makeConfig({ decision: noDefault }));

      const schema = tool.inputSchema as {
        properties: Record<string, { description?: string }>;
        required: string[];
      };
      expect(schema.required.sort()).toEqual(["model", "questions", "state"]);
      expect(schema.properties.model?.description).toContain("Required");
      expect(tool.description).not.toContain("typesafe-main");
    });

    it("appears in the OpenAI tool catalog", () => {
      const config = makeConfig({ decision: decisionConfigWithModels });
      const finalizer = createDecisionToolFinalizer(config);
      const ctx = buildBuiltinOnlySessionMcpToolContext();
      const result = finalizer(ctx, "agent:test:discord:channel:123");

      const inLoop = result.toolsLoop.some((t) => t.name === "builtin-decision");
      expect(inLoop).toBe(true);
    });
  });
});
