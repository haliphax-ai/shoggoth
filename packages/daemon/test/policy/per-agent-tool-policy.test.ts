import assert from "node:assert";
import { describe, it } from "vitest";
import { DEFAULT_POLICY_CONFIG, type ShoggothConfig, type ShoggothToolRules } from "@shoggoth/shared";
import {
  createPolicyEngine,
  evaluateRules,
  resolveEffectiveToolRules,
} from "../../src/policy/engine";

describe("resolveEffectiveToolRules", () => {
  const globalRules: ShoggothToolRules = {
    allow: ["*"],
    deny: [],
    review: ["builtin-exec:bash", "builtin-exec:sh"],
  };

  it("returns global rules when no per-agent config exists", () => {
    const effective = resolveEffectiveToolRules(globalRules, undefined);
    assert.deepStrictEqual(effective, globalRules);
  });

  it("per-agent review replaces global review", () => {
    const effective = resolveEffectiveToolRules(globalRules, { review: [] });
    assert.deepStrictEqual(effective, { allow: ["*"], deny: [], review: [] });
  });

  it("per-agent allow replaces global allow, inherits other fields", () => {
    const effective = resolveEffectiveToolRules(globalRules, { allow: ["builtin-read"] });
    assert.deepStrictEqual(effective, {
      allow: ["builtin-read"],
      deny: [],
      review: ["builtin-exec:bash", "builtin-exec:sh"],
    });
  });

  it("per-agent deny replaces global deny, inherits other fields", () => {
    const effective = resolveEffectiveToolRules(globalRules, { deny: ["builtin-exec"] });
    assert.deepStrictEqual(effective, {
      allow: ["*"],
      deny: ["builtin-exec"],
      review: ["builtin-exec:bash", "builtin-exec:sh"],
    });
  });

  it("per-agent can replace all fields", () => {
    const effective = resolveEffectiveToolRules(globalRules, {
      allow: ["builtin-read"],
      deny: ["builtin-write"],
      review: ["builtin-exec"],
    });
    assert.deepStrictEqual(effective, {
      allow: ["builtin-read"],
      deny: ["builtin-write"],
      review: ["builtin-exec"],
    });
  });
});

describe("evaluateRules – review takes precedence over allow", () => {
  it("review match blocks even when allow:* is set", () => {
    const rules: ShoggothToolRules = { allow: ["*"], deny: [], review: ["builtin-exec:bash"] };
    const decision = evaluateRules("builtin-exec:bash", rules);
    assert.deepStrictEqual(decision, { allow: false, reason: "requires_review" });
  });

  it("non-reviewed tool still allowed", () => {
    const rules: ShoggothToolRules = { allow: ["*"], deny: [], review: ["builtin-exec:bash"] };
    const decision = evaluateRules("builtin-read", rules);
    assert.deepStrictEqual(decision, { allow: true });
  });
});

describe("policy engine – per-agent tool rules via config", () => {
  it("agent with per-agent policy gets merged rules", () => {
    const config: ShoggothConfig["policy"] = {
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["*"], deny: [], review: ["builtin-exec:bash", "builtin-exec:sh"] },
      },
    };
    const agentsConfig: ShoggothConfig["agents"] = {
      list: {
        main: {
          policy: { tools: { review: [] } },
        },
      },
    };
    const engine = createPolicyEngine(config, agentsConfig);
    const decision = engine.check({
      principal: { kind: "agent", sessionId: "agent:main:discord:ch:123", source: "agent" },
      action: "tool.invoke",
      resource: "builtin-exec:bash",
    });
    assert.deepStrictEqual(decision, { allow: true });
  });

  it("agent without per-agent policy inherits global review", () => {
    const config: ShoggothConfig["policy"] = {
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["*"], deny: [], review: ["builtin-exec:bash"] },
      },
    };
    const engine = createPolicyEngine(config);
    const decision = engine.check({
      principal: { kind: "agent", sessionId: "agent:helper:discord:ch:456", source: "agent" },
      action: "tool.invoke",
      resource: "builtin-exec:bash",
    });
    assert.deepStrictEqual(decision, { allow: false, reason: "requires_review" });
  });

  it("unknown agent id falls back to global", () => {
    const config: ShoggothConfig["policy"] = {
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["*"], deny: [], review: ["builtin-exec:bash"] },
      },
    };
    const agentsConfig: ShoggothConfig["agents"] = {
      list: {
        main: {
          policy: { tools: { review: [] } },
        },
      },
    };
    const engine = createPolicyEngine(config, agentsConfig);
    // Agent "other" has no per-agent config, falls back to global
    const decision = engine.check({
      principal: { kind: "agent", sessionId: "agent:other:discord:ch:789", source: "agent" },
      action: "tool.invoke",
      resource: "builtin-exec:bash",
    });
    assert.deepStrictEqual(decision, { allow: false, reason: "requires_review" });
  });

  it("operator is unaffected by per-agent config", () => {
    const config: ShoggothConfig["policy"] = {
      ...DEFAULT_POLICY_CONFIG,
      agent: {
        ...DEFAULT_POLICY_CONFIG.agent,
        tools: { allow: ["*"], deny: [], review: ["builtin-exec:bash"] },
      },
    };
    const agentsConfig: ShoggothConfig["agents"] = {
      list: { main: { policy: { tools: { review: [] } } } },
    };
    const engine = createPolicyEngine(config, agentsConfig);
    const decision = engine.check({
      principal: {
        kind: "operator",
        operatorId: "op",
        roles: [],
        source: "cli_socket",
      },
      action: "tool.invoke",
      resource: "builtin-exec:bash",
    });
    // Operator uses operator.tools which has allow:* and no review
    assert.deepStrictEqual(decision, { allow: true });
  });
});
