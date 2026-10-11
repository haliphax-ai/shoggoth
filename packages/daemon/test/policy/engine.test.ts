import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import assert from "node:assert";
import { describe, it } from "vitest";
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

  it("treats missing rule lists as empty instead of crashing", () => {
    // A partial policy config (e.g. hot-reloaded fragment missing a tier)
    // must not throw `Cannot read properties of undefined (reading 'includes')`.
    const partial = {
      allow: undefined as unknown as string[],
      deny: undefined as unknown as string[],
      review: undefined as unknown as string[],
    };
    assert.deepStrictEqual(evaluateRules("read", partial), {
      allow: false,
      reason: "default_deny",
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
      source: "cli_operator_token",
      peer: { uid: 1, gid: 1, pid: 1 },
    };
    const agent: AuthenticatedPrincipal = {
      kind: "agent",
      sessionId: "s1",
      source: "agent",
    };
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "ping",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "agent_ping",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "agent_ping",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "ping",
      }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "session_context_new",
      }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "session_context_reset",
      }),
      { allow: false, reason: "default_deny" },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "session_context_new",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "subagent_spawn",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "session_inspect",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "session_inspect",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "session_list",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: agent,
        action: "control.invoke",
        resource: "session_send",
      }),
      { allow: true },
    );
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "session_send",
      }),
      { allow: true },
    );
  });

  it("emptyPolicyConfig denies control and tools", () => {
    const engine = createPolicyEngine(emptyPolicyConfig());
    const operator: AuthenticatedPrincipal = {
      kind: "operator",
      operatorId: "op",
      roles: [],
      source: "cli_operator_token",
    };
    assert.deepStrictEqual(
      engine.check({
        principal: operator,
        action: "control.invoke",
        resource: "ping",
      }),
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
      evaluateRules("builtin-exec:bash", {
        allow: ["builtin-exec:*"],
        deny: [],
        review: ["builtin-exec:bash"],
      }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("non-review resource still auto-approved", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:curl", {
        allow: ["builtin-exec:*"],
        deny: [],
        review: ["builtin-exec:bash"],
      }),
      { allow: true },
    );
  });

  it("deny wins over review", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:bash", {
        allow: ["builtin-exec:*"],
        deny: ["builtin-exec:bash"],
        review: ["builtin-exec:bash"],
      }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("review without allow still returns requires_review", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:bash", {
        allow: [],
        deny: [],
        review: ["builtin-exec:bash"],
      }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("empty review list is backward compatible (allow works)", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-read", {
        allow: ["builtin-read"],
        deny: [],
        review: [],
      }),
      { allow: true },
    );
  });

  it("missing review field is backward compatible (allow works)", () => {
    assert.deepStrictEqual(evaluateRules("builtin-exec", { allow: ["builtin-exec"], deny: [] }), {
      allow: true,
    });
  });

  it("review with wildcard matches all sub-resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:curl", {
        allow: ["builtin-exec:*"],
        deny: [],
        review: ["builtin-exec:*"],
      }),
      { allow: false, reason: "requires_review" },
    );
  });

  it("bare tool in review matches sub-resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:curl", {
        allow: ["builtin-exec:*"],
        deny: [],
        review: ["builtin-exec"],
      }),
      { allow: false, reason: "requires_review" },
    );
  });
});

describe("evaluateRules – deny/review glob patterns", () => {
  it("deny glob matches the namespaced tool id and beats allow regardless of ordering", () => {
    // MCP tool ids are flat and hyphen-namespaced (`kanban-get_cards`, see the
    // `namespaced()` helper in mcp-integration/aggregate.ts), so `kanban-*`
    // matches them the same way it matches in tool-enable globs elsewhere.
    assert.deepStrictEqual(
      evaluateRules("kanban-get_cards", {
        allow: ["*"],
        deny: ["kanban-*"],
        review: [],
      }),
      { allow: false, reason: "explicit_deny" },
    );
    // Deny beats allow even when allow names the exact resource.
    assert.deepStrictEqual(
      evaluateRules("kanban-get_cards", {
        allow: ["kanban-get_cards"],
        deny: ["kanban-*"],
        review: [],
      }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("deny glob does not match other tools", () => {
    assert.deepStrictEqual(evaluateRules("git", { allow: ["*"], deny: ["kanban-*"], review: [] }), {
      allow: true,
    });
    assert.deepStrictEqual(
      evaluateRules("builtin-read", { allow: ["*"], deny: ["kanban-*"], review: [] }),
      { allow: true },
    );
  });

  it("deny glob matches compound tool:sub resources", () => {
    // `tool:sub` compounds only arise for tools with sub-resource extractors
    // (builtin-exec today); a glob over the full compound resource covers them.
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:curl", { allow: ["*"], deny: ["builtin-exec:c*"], review: [] }),
      { allow: false, reason: "explicit_deny" },
    );
    assert.deepStrictEqual(
      evaluateRules("builtin-exec:ls", { allow: ["*"], deny: ["builtin-exec:c*"], review: [] }),
      { allow: true },
    );
  });

  it("deny glob beats review glob", () => {
    assert.deepStrictEqual(
      evaluateRules("kanban-get_cards", {
        allow: ["*"],
        deny: ["kanban-*"],
        review: ["kanban-*"],
      }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("review glob queues even when allow matches", () => {
    assert.deepStrictEqual(
      evaluateRules("kanban-get_cards", {
        allow: ["*"],
        deny: [],
        review: ["kanban-*"],
      }),
      { allow: false, reason: "requires_review" },
    );
    assert.deepStrictEqual(evaluateRules("git", { allow: ["*"], deny: [], review: ["kanban-*"] }), {
      allow: true,
    });
  });

  it("? wildcard matches exactly one character", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:x", { allow: ["*"], deny: ["exec:?"], review: [] }),
      {
        allow: false,
        reason: "explicit_deny",
      },
    );
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["*"], deny: ["exec:?"], review: [] }),
      { allow: true },
    );
  });

  it("exact, prefix, bare, and * deny entries are unchanged", () => {
    // exact
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["*"], deny: ["exec:curl"], review: [] }),
      { allow: false, reason: "explicit_deny" },
    );
    // tool:* prefix
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["*"], deny: ["exec:*"], review: [] }),
      {
        allow: false,
        reason: "explicit_deny",
      },
    );
    // bare tool (backward compat)
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["*"], deny: ["exec"], review: [] }),
      {
        allow: false,
        reason: "explicit_deny",
      },
    );
    // * blocks all
    assert.deepStrictEqual(evaluateRules("git", { allow: ["*"], deny: ["*"], review: [] }), {
      allow: false,
      reason: "explicit_deny",
    });
  });

  it("missing deny/review lists stay safe alongside glob entries", () => {
    const denyMissing = {
      allow: ["*"],
      deny: undefined as unknown as string[],
      review: ["kanban-*"],
    };
    assert.deepStrictEqual(evaluateRules("kanban-get_cards", denyMissing), {
      allow: false,
      reason: "requires_review",
    });
    assert.deepStrictEqual(
      evaluateRules("kanban-get_cards", {
        allow: ["*"],
        deny: ["kanban-*"],
        review: undefined as unknown as string[],
      }),
      { allow: false, reason: "explicit_deny" },
    );
    // Glob entries that match nothing must not change the decision.
    assert.deepStrictEqual(evaluateRules("git", { allow: ["*"], deny: ["kanban-*"], review: [] }), {
      allow: true,
    });
  });
});

describe("redactToolArgsJson", () => {
  it("redacts dot paths", () => {
    const out = redactToolArgsJson(JSON.stringify({ password: "x", nested: { token: "y" } }), [
      "password",
      "nested.token",
    ]);
    const o = JSON.parse(out!) as {
      password: string;
      nested: { token: string };
    };
    assert.strictEqual(o.password, "[REDACTED]");
    assert.strictEqual(o.nested.token, "[REDACTED]");
  });
});
