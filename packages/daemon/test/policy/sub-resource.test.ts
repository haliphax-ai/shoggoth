import assert from "node:assert";
import { describe, it } from "vitest";
import { evaluateRules } from "../../src/policy/engine";

describe("evaluateRules — sub-resource (compound) matching", () => {
  it("exact compound match: builtin.exec:curl allowed by builtin.exec:curl", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:curl"], deny: [] }),
      { allow: true },
    );
  });

  it("wildcard compound match: builtin.exec:curl allowed by builtin.exec:*", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:*"], deny: [] }),
      { allow: true },
    );
  });

  it("bare tool name allows all sub-resources (backward compat): builtin.exec:curl allowed by builtin.exec", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec"], deny: [] }),
      { allow: true },
    );
  });

  it("mismatched sub-resource denied: builtin.exec:rm not allowed by builtin.exec:git", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:rm", { allow: ["builtin.exec:git"], deny: [] }),
      { allow: false, reason: "default_deny" },
    );
  });

  it("explicit deny wins over wildcard allow: builtin.exec:bash denied", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:bash", { allow: ["builtin.exec:*"], deny: ["builtin.exec:bash"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("bare tool without sub-resource not matched by specific sub-resource rule", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec", { allow: ["builtin.exec:curl"], deny: [] }),
      { allow: false, reason: "default_deny" },
    );
  });

  it("non-compound resources unchanged: builtin.read allowed by builtin.read", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.read", { allow: ["builtin.read"], deny: [] }),
      { allow: true },
    );
  });

  it("bare tool deny blocks all sub-resources: builtin.exec:git denied by deny builtin.exec", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:git", { allow: ["builtin.exec:*"], deny: ["builtin.exec"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("wildcard deny blocks all sub-resources: builtin.exec:ls denied by deny builtin.exec:*", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:ls", { allow: ["builtin.exec:ls"], deny: ["builtin.exec:*"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });

  it("mixed rules: allow builtin.exec:git and builtin.read, deny builtin.exec:rm", () => {
    const rules = { allow: ["builtin.exec:git", "builtin.exec:ls", "builtin.read", "builtin.write"], deny: ["builtin.exec:rm"] };
    assert.deepStrictEqual(evaluateRules("builtin.exec:git", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("builtin.exec:ls", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("builtin.read", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("builtin.write", rules), { allow: true });
    assert.deepStrictEqual(evaluateRules("builtin.exec:rm", rules), { allow: false, reason: "explicit_deny" });
    assert.deepStrictEqual(evaluateRules("builtin.exec:curl", rules), { allow: false, reason: "default_deny" });
  });

  it("global * still works with compound resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["*"], deny: [] }),
      { allow: true },
    );
  });

  it("global deny * blocks compound resources", () => {
    assert.deepStrictEqual(
      evaluateRules("builtin.exec:curl", { allow: ["builtin.exec:curl"], deny: ["*"] }),
      { allow: false, reason: "explicit_deny" },
    );
  });
});
