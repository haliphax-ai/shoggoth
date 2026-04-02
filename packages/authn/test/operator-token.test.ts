import assert from "node:assert";
import { describe, it } from "vitest";
import { validateOperatorToken } from "../src/operator-token";

describe("operator token", () => {
  it("accepts matching secret", () => {
    assert.strictEqual(validateOperatorToken("secret-a", "secret-a"), true);
  });

  it("rejects mismatch", () => {
    assert.strictEqual(validateOperatorToken("secret-a", "secret-b"), false);
  });

  it("rejects length mismatch without throwing", () => {
    assert.strictEqual(validateOperatorToken("x", "longer-token-value"), false);
  });
});
