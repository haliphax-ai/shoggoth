import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuiltinToolContext } from "../../src/sessions/builtin-tool-registry";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register } from "../../src/sessions/builtin-handlers/rerank-handler";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";

function makeConfig(rerank?: ShoggothConfig["rerank"]): ShoggothConfig {
  return { ...defaultConfig("/tmp/cfg"), rerank } as ShoggothConfig;
}

const configuredRerank: NonNullable<ShoggothConfig["rerank"]> = {
  providers: {
    "openrouter-cohere": {
      kind: "cohere",
      baseUrl: "https://openrouter.ai/api",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [{ name: "cohere/rerank-v3.5" }],
    },
  },
};

function makeCtx(
  config: ShoggothConfig,
  invoker?: (sessionId: string, op: string, payload: unknown) => Promise<unknown>,
): BuiltinToolContext {
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    config,
    env: process.env,
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => invoker,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: config.memory,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

const validArgs = {
  model: "openrouter-cohere/cohere/rerank-v3.5",
  query: "Where can I review my billing history?",
  documents: ["Billing history lives in the dashboard.", "Shipping policies for orders."],
};

describe("rerank-handler", () => {
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);
  });

  it("allows omitted model (config default applies downstream)", async () => {
    const invoker = vi.fn().mockResolvedValue({ status: "complete", results: [] });
    const ctx = makeCtx(makeConfig(configuredRerank), invoker);

    const { model: _omitted, ...argsWithoutModel } = validArgs;
    const result = await registry.execute("rerank", argsWithoutModel, ctx);

    expect(invoker.mock.calls.length).toBe(1);
    const [, op, payload] = invoker.mock.calls[0] as [string, string, any];
    expect(op).toBe("rerank_documents");
    expect("model" in payload).toBe(false);
    expect(JSON.parse(result.resultJson).status).toBe("complete");
  });

  it("rejects a non-string model", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, model: 42 }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("model");
  });

  it("returns error when query is missing", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, query: undefined }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("query");
  });

  it("returns error when query is blank", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, query: "   " }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("query");
  });

  it("returns error when documents is missing", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, documents: undefined }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("documents");
  });

  it("returns error when documents is empty", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, documents: [] }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("documents");
  });

  it("returns error when a document is not a non-empty string", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, documents: ["ok", 42] }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("document");
  });

  it("returns error when top_n is not a positive number", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank));
    const result = await registry.execute("rerank", { ...validArgs, top_n: 0 }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("top_n");
  });

  it("returns error when rerank is not configured", async () => {
    const ctx = makeCtx(makeConfig(undefined));
    const result = await registry.execute("rerank", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("not configured");
  });

  it("returns error when no provider has models", async () => {
    const ctx = makeCtx(
      makeConfig({
        providers: {
          "openrouter-cohere": {
            kind: "cohere",
            baseUrl: "https://openrouter.ai/api",
            models: [],
          },
        },
      }),
    );
    const result = await registry.execute("rerank", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("not configured");
  });

  it("returns error when integration invoker is unavailable", async () => {
    const ctx = makeCtx(makeConfig(configuredRerank), undefined);
    const result = await registry.execute("rerank", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("invoker");
  });

  it("invokes the rerank_documents control op with model, query, and documents", async () => {
    const invoker = vi.fn().mockResolvedValue({
      status: "complete",
      model: "cohere/rerank-v3.5",
      results: [{ index: 0, relevance_score: 0.97 }],
    });
    const ctx = makeCtx(makeConfig(configuredRerank), invoker);

    const result = await registry.execute("rerank", validArgs, ctx);

    expect(invoker.mock.calls.length).toBe(1);
    const [sessionId, op, payload] = invoker.mock.calls[0] as [string, string, any];
    expect(sessionId).toBe("agent:test:discord:channel:123");
    expect(op).toBe("rerank_documents");
    expect(payload.model).toBe("openrouter-cohere/cohere/rerank-v3.5");
    expect(payload.query).toBe(validArgs.query);
    expect(payload.documents).toEqual(validArgs.documents);
    expect(payload.timeout_ms).toBeUndefined();

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.status).toBe("complete");
    expect(parsed.results[0].relevance_score).toBe(0.97);
  });

  it("passes top_n and timeout_ms through when provided", async () => {
    const invoker = vi.fn().mockResolvedValue({ status: "complete", results: [] });
    const ctx = makeCtx(makeConfig(configuredRerank), invoker);

    await registry.execute("rerank", { ...validArgs, top_n: 3, timeout_ms: 10_000 }, ctx);

    const [, , payload] = invoker.mock.calls[0] as [string, string, any];
    expect(payload.top_n).toBe(3);
    expect(payload.timeout_ms).toBe(10_000);
  });

  it("passes service errors through to the agent", async () => {
    const invoker = vi
      .fn()
      .mockResolvedValue({ status: "error", error: "No provider found for model: nope" });
    const ctx = makeCtx(makeConfig(configuredRerank), invoker);

    const result = await registry.execute("rerank", { ...validArgs, model: "nope" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("nope");
  });

  it("returns error JSON when the invoker throws", async () => {
    const invoker = vi.fn().mockRejectedValue(new Error("socket closed"));
    const ctx = makeCtx(makeConfig(configuredRerank), invoker);

    const result = await registry.execute("rerank", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("socket closed");
  });
});
