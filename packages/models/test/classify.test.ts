import { describe, it } from "vitest";
import assert from "node:assert";
import { isFailoverEligibleError } from "../src/classify";
import { ModelHttpError } from "../src/errors";

describe("isFailoverEligibleError", () => {
  it("returns true for 429 Too Many Requests", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(429, "rate limit")), true);
  });

  it("returns true for 502/503/504", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(502, "bad gateway")), true);
    assert.equal(isFailoverEligibleError(new ModelHttpError(503, "unavailable")), true);
    assert.equal(isFailoverEligibleError(new ModelHttpError(504, "timeout")), true);
  });

  it("returns true for 500 Internal Server Error", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(500, "boom")), true);
  });

  it("returns true for other transient 5xx (e.g. edge 522)", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(522, "connection timed out")), true);
  });

  it("returns false for 401 Unauthorized", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(401, "auth")), false);
  });

  it("returns false for 400 Bad Request", () => {
    assert.equal(isFailoverEligibleError(new ModelHttpError(400, "bad")), false);
  });

  it("returns true for network-like TypeError fetch failed", () => {
    const e = new TypeError("fetch failed");
    assert.equal(isFailoverEligibleError(e), true);
  });
});
