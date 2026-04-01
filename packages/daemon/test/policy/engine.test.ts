import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import {
  createPolicyEngine,
  emptyPolicyConfig,
  evaluateRules,
  isDefinedControlOp,
} from "../../src/policy/engine";
import { redactToolArgsJson } from "../../src/policy/redact-json";

describe("policy engine", () => {
  it("default-deny when allow is empty and no wildcard", () => {
    assert.deepStrictEqual(evaluateRules("read", { allow: [], deny: [] }), {
      allow: false,
      reason: "default_deny",
    });
  });

  it("allow * permits unless denied", () => {
    assert.deepStrictEqual(evaluateRules("anything", { allow: ["*"], deny: [] }), {
      allow: true,
    });
    assert.deepStrictEqual(evaluateRules("read", { allow: ["*"], deny: ["read"] }), {
      allow: false,
      reason: "explicit_deny",
    });
  });

  it("deny * blocks all", () => {
    assert.deepStrictEqual(evaluateRules("ping", { allow: ["ping"], deny: ["*"] }), {
      allow: false,
      reason: "explicit_deny",
    });
  });

  it("maps operator vs agent principals (DEFAULT_POLICY_CONFIG)", () => {
    const engine = createPolicyEngine(DEFAULT_POLICY_CONFIG);
    const operator: AuthenticatedPrincipal = {
      kind: "operator",
      operatorId: "op",
      roles: ["admin"],
      source: "cli_socket",
      peer: { uid: 1, gid: 1, pid: 1 },
    };
    const agent: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s1",
      source: "agent",
    };
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "ping" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "agent_ping" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "agent_ping" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "ping" }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "session_context_new" }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "session_context_reset" }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "session_context_new" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "subagent_spawn" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "session_inspect" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "session_inspect" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "session_list" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: agent, action: "control.invoke", resource: "session_send" }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "session_send" }),
      { allow: true },
    );
  });

  it("emptyPolicyConfig denies control and tools", () => {
    const engine = createPolicyEngine(emptyPolicyConfig());
    const operator: AuthenticatedPrincipal = {
      kind: "operator",
      operatorId: "op",
      roles: [],
      source: "cli_socket",
    };
    assert.deepStrictEqual(
      engine.check({ principal: operator, action: "control.invoke", resource: "ping" }),
      { allow: false, reason: "default_deny" },
    );
  });

  it("isDefinedControlOp", () => {
    assert.equal(isDefinedControlOp("ping"), true);
    assert.equal(isDefinedControlOp("mcp_http_cancel_request"), true);
    assert.equal(isDefinedControlOp("session_context_new"), true);
    assert.equal(isDefinedControlOp("session_context_reset"), true);
    assert.equal(isDefinedControlOp("subagent_spawn"), true);
    assert.equal(isDefinedControlOp("session_abort"), true);
    assert.equal(isDefinedControlOp("session_list"), true);
    assert.equal(isDefinedControlOp("session_send"), true);
    assert.equal(isDefinedControlOp("nope"), false);
  });
});

describe("evaluateRules – review list", () => {
  it("review match returns requires_review even when allow matches", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:bash", { allow: ["builtin.exec:*"], deny: [], review: ["builtin.exec:bash"] }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("non-review resource still auto-approved", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:*"], deny: [], review: ["builtin.exec:bash"] }),
      { allow: true },
    );
  });

  it("deny wins over review", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:bash", { allow: ["builtin.exec:*"], deny: ["builtin.exec:bash"], review: ["builtin.exec:bash"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("review without allow still returns requires_review", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:bash", { allow: [], deny: [], review: ["builtin.exec:bash"] }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("empty review list is backward compatible (allow works)", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.read", { allow: ["builtin.read"], deny: [], review: [] }),
      { allow: true },
    );
  });

  it("missing review field is backward compatible (allow works)", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec", { allow: ["builtin.exec"], deny: [] }),
      { allow: true },
    );
  });

  it("review with wildcard matches all sub-resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:*"], deny: [], review: ["builtin.exec:*"] }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("bare tool in review matches sub-resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:*"], deny: [], review: ["builtin.exec"] }),
      { allow: false, reason: "requires_review" },
    );
  });
});

describe("redactToolArgsJson", () => {
  it("redacts dot paths", () => {
    const out = redactToolArgsJson(
      JSON.stringify({ password: "x", nested: { token: "y" } }),
      ["password", "nested.token"],
    );
    const o = JSON.parse(out!) as { password: string; nested: { token: string } };
    assert.strictEqual(o.password, "[REDACTED]");
    assert.strictEqual(o.nested.token, "[REDACTED]");
  });
});
