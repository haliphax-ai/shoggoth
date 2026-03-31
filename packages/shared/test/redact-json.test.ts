import assert from "node:assert";
import { describe, it } from "node:test";
import { redactDeep } from "../src/redact-json.js";

describe("redactDeep", () => {
  it("returns input unchanged when jsonPaths is empty", () => {
    const obj = { token: "secret", nested: { token: "s2" } };
    assert.deepStrictEqual(redactDeep(obj, []), obj);
  });

  it("redacts single-segment path at root level", () => {
    const result = redactDeep({ token: "abc", name: "ok" }, ["token"]);
    assert.deepStrictEqual(result, { token: "[REDACTED]", name: "ok" });
  });

  it("redacts single-segment path at nested levels", () => {
    const obj = { a: { b: { token: "deep" }, token: "mid" }, token: "top" };
    const result = redactDeep(obj, ["token"]);
    assert.strictEqual(result.token, "[REDACTED]");
    assert.strictEqual((result.a as any).token, "[REDACTED]");
    assert.strictEqual((result.a as any).b.token, "[REDACTED]");
  });

  it("redacts multi-segment path at any depth", () => {
    const obj = { env: { API_KEY: "k1" }, platforms: { env: { API_KEY: "k2" } } };
    const result = redactDeep(obj, ["env.API_KEY"]);
    assert.strictEqual((result as any).env.API_KEY, "[REDACTED]");
    assert.strictEqual((result as any).platforms.env.API_KEY, "[REDACTED]");
  });

  it("handles no matches gracefully", () => {
    const obj = { name: "test", value: 42 };
    assert.deepStrictEqual(redactDeep(obj, ["token"]), obj);
  });

  it("handles nested arrays", () => {
    const obj = { items: [{ token: "a" }, { token: "b", nested: { token: "c" } }] };
    const result = redactDeep(obj, ["token"]);
    assert.strictEqual((result.items as any)[0].token, "[REDACTED]");
    assert.strictEqual((result.items as any)[1].token, "[REDACTED]");
    assert.strictEqual((result.items as any)[1].nested.token, "[REDACTED]");
  });

  it("leaves already-redacted values as-is", () => {
    const obj = { token: "[REDACTED]", other: "ok" };
    const result = redactDeep(obj, ["token"]);
    assert.strictEqual(result.token, "[REDACTED]");
    assert.strictEqual(result.other, "ok");
  });

  it("does not mutate the original object", () => {
    const obj = { token: "secret" };
    redactDeep(obj, ["token"]);
    assert.strictEqual(obj.token, "secret");
  });

  it("handles null and undefined inputs", () => {
    assert.strictEqual(redactDeep(null, ["token"]), null);
    assert.strictEqual(redactDeep(undefined, ["token"]), undefined);
  });
});
