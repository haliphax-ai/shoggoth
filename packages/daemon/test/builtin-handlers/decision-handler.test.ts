import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuiltinToolContext } from "../../src/sessions/builtin-tool-registry";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register } from "../../src/sessions/builtin-handlers/decision-handler";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";

const mockEvaluate = vi.fn();

function makeConfig(decision?: ShoggothConfig["decision"]): ShoggothConfig {
  return { ...defaultConfig("/tmp/cfg"), decision } as ShoggothConfig;
}

const configuredDecision: NonNullable<ShoggothConfig["decision"]> = {
  providers: {
    "typesafe-main": {
      kind: "typesafe",
      baseUrl: "https://api.typesafe.ai",
      apiKeyEnv: "TYPESAFE_API_KEY",
      models: { "jev-latest": {} },
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
  model: "typesafe-main/jev-latest",
  state: "Help! My payouts have been failing for 3 days.",
  questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
};

describe("decision-handler", () => {
  let registry: BuiltinToolRegistry;

  beforeEach(() => {
    registry = new BuiltinToolRegistry();
    register(registry);
    mockEvaluate.mockReset();
  });

  it("allows omitted model (config default applies downstream)", async () => {
    const invoker = vi.fn().mockResolvedValue({ status: "complete", answers: {} });
    const ctx = makeCtx(makeConfig(configuredDecision), invoker);

    const { model: _omitted, ...argsWithoutModel } = validArgs;
    const result = await registry.execute("decision", argsWithoutModel, ctx);

    expect(invoker.mock.calls.length).toBe(1);
    const [, op, payload] = invoker.mock.calls[0] as [string, string, any];
    expect(op).toBe("decision_evaluate");
    expect("model" in payload).toBe(false);
    expect(JSON.parse(result.resultJson).status).toBe("complete");
  });

  it("rejects a non-string model", async () => {
    const ctx = makeCtx(makeConfig(configuredDecision));
    const result = await registry.execute("decision", { ...validArgs, model: 42 }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("model");
  });

  it("returns error when state is missing", async () => {
    const ctx = makeCtx(makeConfig(configuredDecision));
    const result = await registry.execute("decision", { ...validArgs, state: undefined }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("state");
  });

  it("returns error when questions is missing", async () => {
    const ctx = makeCtx(makeConfig(configuredDecision));
    const result = await registry.execute("decision", { ...validArgs, questions: undefined }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("questions");
  });

  it("returns error when questions is not an object", async () => {
    const ctx = makeCtx(makeConfig(configuredDecision));
    const result = await registry.execute("decision", { ...validArgs, questions: "urgent?" }, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("questions");
  });

  it("returns error when decision is not configured", async () => {
    const ctx = makeCtx(makeConfig(undefined));
    const result = await registry.execute("decision", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("not configured");
  });

  it("returns error when no provider has models", async () => {
    const ctx = makeCtx(
      makeConfig({
        providers: {
          "typesafe-main": {
            kind: "typesafe",
            baseUrl: "https://api.typesafe.ai",
            models: {},
          },
        },
      }),
    );
    const result = await registry.execute("decision", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("not configured");
  });

  it("returns error when integration invoker is unavailable", async () => {
    const ctx = makeCtx(makeConfig(configuredDecision), undefined);
    const result = await registry.execute("decision", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("invoker");
  });

  it("invokes the decision_evaluate control op with model, state, and questions", async () => {
    const invoker = vi.fn().mockResolvedValue({
      status: "complete",
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", noul: 0.95 } },
      usage: { input_tokens: 307, output_tokens: 20 },
    });
    const ctx = makeCtx(makeConfig(configuredDecision), invoker);

    const result = await registry.execute("decision", validArgs, ctx);

    expect(invoker.mock.calls.length).toBe(1);
    const [sessionId, op, payload] = invoker.mock.calls[0] as [string, string, any];
    expect(sessionId).toBe("agent:test:discord:channel:123");
    expect(op).toBe("decision_evaluate");
    expect(payload.model).toBe("typesafe-main/jev-latest");
    expect(payload.state).toBe(validArgs.state);
    expect(payload.questions).toEqual(validArgs.questions);
    expect(payload.timeout_ms).toBeUndefined();

    const parsed = JSON.parse(result.resultJson);
    expect(parsed.status).toBe("complete");
    expect(parsed.answers.is_urgent.noul).toBe(0.95);
  });

  it("passes timeout_ms through when provided", async () => {
    const invoker = vi.fn().mockResolvedValue({ status: "complete", answers: {} });
    const ctx = makeCtx(makeConfig(configuredDecision), invoker);

    await registry.execute("decision", { ...validArgs, timeout_ms: 10_000 }, ctx);

    const [, , payload] = invoker.mock.calls[0] as [string, string, any];
    expect(payload.timeout_ms).toBe(10_000);
  });

  it("passes service errors through to the agent", async () => {
    const invoker = vi
      .fn()
      .mockResolvedValue({ status: "error", error: "No provider found for model: nope" });
    const ctx = makeCtx(makeConfig(configuredDecision), invoker);

    const result = await registry.execute("decision", { ...validArgs, model: "nope" }, ctx);
    const parsed = JSON.parse(result.resultJson);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("nope");
  });

  it("returns error JSON when the invoker throws", async () => {
    const invoker = vi.fn().mockRejectedValue(new Error("socket closed"));
    const ctx = makeCtx(makeConfig(configuredDecision), invoker);

    const result = await registry.execute("decision", validArgs, ctx);
    expect(JSON.parse(result.resultJson).error).toContain("socket closed");
  });
});
