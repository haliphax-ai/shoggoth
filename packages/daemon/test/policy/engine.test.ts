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
      { allow: false, reason: "default_deny" },
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
    assert.equal(isDefinedControlOp("canvas_authorize"), true);
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
