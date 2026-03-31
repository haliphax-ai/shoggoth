import assert from "node:assert";
import { describe, it } from "node:test";
import { evaluateRules } from "../../src/policy/engine";

describe("evaluateRules — sub-resource (compound) matching", () => {
  it("exact compound match: exec:curl allowed by exec:curl", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["exec:curl"], deny: [] }),
      { allow: true },
    );
  });

  it("wildcard compound match: exec:curl allowed by exec:*", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["exec:*"], deny: [] }),
      { allow: true },
    );
  });

  it("bare tool name allows all sub-resources (backward compat): exec:curl allowed by exec", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["exec"], deny: [] }),
      { allow: true },
    );
  });

  it("mismatched sub-resource denied: exec:rm not allowed by exec:git", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:rm", { allow: ["exec:git"], deny: [] }),
      { allow: false, reason: "default_deny" },
    );
  });

  it("explicit deny wins over wildcard allow: exec:bash denied", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:bash", { allow: ["exec:*"], deny: ["exec:bash"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("bare tool without sub-resource not matched by specific sub-resource rule", () => {
    assert.deepStrictEqual(
      evaluateRules("exec", { allow: ["exec:curl"], deny: [] }),
      { allow: false, reason: "default_deny" },
    );
  });

  it("non-compound resources unchanged: read allowed by read", () => {
    assert.deepStrictEqual(
      evaluateRules("read", { allow: ["read"], deny: [] }),
      { allow: true },
    );
  });

  it("bare tool deny blocks all sub-resources: exec:git denied by deny exec", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:git", { allow: ["exec:*"], deny: ["exec"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("wildcard deny blocks all sub-resources: exec:ls denied by deny exec:*", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:ls", { allow: ["exec:ls"], deny: ["exec:*"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("mixed rules: allow exec:git and read, deny exec:rm", () => {
    const rules = { allow: ["exec:git", "exec:ls", "read", "write"], deny: ["exec:rm"] };
    assert.deepStrictEqual(evaluateRules("exec:git", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("exec:ls", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("read", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("write", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("exec:rm", rules), { allow: false, reason: "explicit_deny" });
    assert.deepStrictEqual(evaluateRules("exec:curl", rules), { allow: false, reason: "default_deny" });
  });

  it("global * still works with compound resources", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["*"], deny: [] }),
      { allow: true },
    );
  });

  it("global deny * blocks compound resources", () => {
    assert.deepStrictEqual(
      evaluateRules("exec:curl", { allow: ["exec:curl"], deny: ["*"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });
});
